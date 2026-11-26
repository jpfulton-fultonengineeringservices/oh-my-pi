/**
 * The remembered record's title is its own text, never the caller's framing.
 *
 * Defect: `save` sent the caller-supplied free-text `context` as the record `title`.
 * Two DISTINCT records stored under the same context then shared one title — and the
 * title is how an operator tells records apart before erasing one, so the collision
 * cost a record erased by mistake on the live Dell. The fix derives the title from
 * the record's own first line (bounded, `…`-capped) and carries `context` as a
 * recoverable `context=<value>` tag instead.
 *
 * The service is stubbed in-process with `Bun.serve` (the house pattern from
 * `test/hindsight-outbox.test.ts:35-64`, also used by `test/memvidkb-backend.test.ts`);
 * the real client rides the real socket, and the assertions read the wire body the
 * stub captured — the only evidence that says what actually left the process.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { memvidkbBackend } from "../src/memvidkb/backend";
import { inspectRecord } from "../src/memvidkb/client-records";
import { REMEMBER_RESPONSE } from "../src/memvidkb/dto";
import { KB_CAPTURE_SOURCE, saveLessonToKb } from "../src/autolearn/kb-sink";
import type { MemoryBackendOperationContext } from "../src/memory-backend/types";

const TOKEN = "kb-title-test-bearer";
const TOKEN_ENV = "MEMVIDKB_TITLE_TEST_TOKEN";

const CONTEXT = "deploy order";
const GATEWAY = "Roll the gateway before the router.";
const VOLUME = "Back up the Postgres volume before the upgrade.";
const PRIOR_ID = "prior-1";
const SUCCESSOR_ID = "succ-77";
/** The `capturedAt` the stub's record detail reports — the read-back proof a destructive edit needs. */
const PRIOR_CAPTURED_AT = "2026-11-16T04:00:00Z";

type Recorded = { method: string; path: string; body: string };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];
// What the stub stored as the successor's title, keyed by successor id: the GET
// detail handler serves it back, so the test asserts the round trip and not just
// the outgoing body.
const successorTitles = new Map<string, string | null>();

function context(): MemoryBackendOperationContext {
	return { agentDir: temp.path(), cwd: temp.path() };
}

function postedRecords(): Array<Record<string, unknown>> {
	return requests
		.filter(r => r.method === "POST" && r.path.endsWith("/records"))
		.map(r => JSON.parse(r.body) as Record<string, unknown>);
}

async function writeConfig(): Promise<void> {
	const doc = {
		version: 1,
		context: "fulton",
		baseUrl,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["dev"],
		remember: "on",
	};
	await Bun.write(`${temp.path()}/.memvidkb`, JSON.stringify(doc));
}

beforeEach(async () => {
	temp = TempDir.createSync("@memvidkb-remember-title-");
	requests = [];
	successorTitles.clear();
	process.env[TOKEN_ENV] = TOKEN;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const recorded: Recorded = { method: request.method, path: url.pathname, body: await request.text() };
			requests.push(recorded);
			if (recorded.method === "POST" && recorded.path.endsWith("/records")) {
				// The deployed service emits `lastVerifiedAt` on this answer
				// (`src/api/records/dto.rs:110-111`); the stub answers like the deployed server.
				return Response.json({
					id: "rec-42",
					uri: "mv2://dev/rec-42",
					frameId: "frame-42",
					track: "dev",
					title: null,
					tags: [],
					originActor: "fulton",
					capturedAt: "2026-11-16T04:00:00Z",
					lastVerifiedAt: null,
					derivedFrom: null,
				});
			}
			if (recorded.method === "POST" && recorded.path.endsWith("/supersede")) {
				const sent = JSON.parse(recorded.body) as Record<string, unknown>;
				successorTitles.set(SUCCESSOR_ID, typeof sent["title"] === "string" ? sent["title"] : null);
				return Response.json({
					priorId: PRIOR_ID,
					newId: SUCCESSOR_ID,
					priorUri: `mv2://dev/${PRIOR_ID}`,
					newUri: `mv2://dev/${SUCCESSOR_ID}`,
				});
			}
			if (recorded.method === "GET" && recorded.path === `/memories/dev/records/${PRIOR_ID}`) {
				// The row a destructive edit has to be seen before it may be overwritten:
				// the edit path refuses to send a supersede unless the caller proves it has
				// read this `capturedAt`, so the stub serves the prior as well as the
				// successor — without it every edit here would be refused before the wire.
				return Response.json({
					id: PRIOR_ID,
					track: "dev",
					uri: `mv2://dev/${PRIOR_ID}`,
					title: VOLUME,
					tags: [],
					text: VOLUME,
					originActor: "fulton",
					capturedAt: PRIOR_CAPTURED_AT,
					lastVerifiedAt: null,
					derivedFrom: null,
					supersededBy: null,
				});
			}
			if (recorded.method === "GET" && recorded.path === `/memories/dev/records/${SUCCESSOR_ID}`) {
				// Serves the title the successor was actually stored with: `null` here is
				// what knowledge-protocol would render as `# <uuid>`.
				return Response.json({
					id: SUCCESSOR_ID,
					track: "dev",
					uri: `mv2://dev/${SUCCESSOR_ID}`,
					title: successorTitles.get(SUCCESSOR_ID) ?? null,
					tags: [],
					text: GATEWAY,
					originActor: "memory-edit",
					capturedAt: "2026-11-18T04:00:00Z",
					lastVerifiedAt: null,
					derivedFrom: PRIOR_ID,
					supersededBy: null,
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	await writeConfig();
});

afterEach(() => {
	server.stop(true);
	delete process.env[TOKEN_ENV];
	void temp.remove();
});

describe("memvidkb remember: title from content, context as tag", () => {
	it("keeps two records stored under one context distinguishable by title", async () => {
		const first = await memvidkbBackend.save!(context(), { content: GATEWAY, context: CONTEXT });
		const second = await memvidkbBackend.save!(context(), { content: VOLUME, context: CONTEXT });
		expect(first.stored).toBe(1);
		expect(second.stored).toBe(1);
		const posted = postedRecords();
		expect(posted).toHaveLength(2);
		const titles = posted.map(body => body["title"]);
		// Distinct content, one shared context: the titles must still tell the records apart.
		expect(titles[0]).toBe(GATEWAY);
		expect(titles[1]).toBe(VOLUME);
		expect(titles[0]).not.toBe(titles[1]);
		// The shared caller prose titles neither record…
		for (const title of titles) expect(title).not.toBe(CONTEXT);
		// …and stays recoverable as a tag on both.
		for (const body of posted) expect(body["tags"]).toEqual([`context=${CONTEXT}`]);
	});

	it("titles from the first line only", async () => {
		await memvidkbBackend.save!(context(), { content: `${GATEWAY}\nDrain first, then verify.`, context: CONTEXT });
		const [body] = postedRecords();
		expect(body?.["title"]).toBe(GATEWAY);
	});

	it("bounds a long first-line title to the cap with an ellipsis", async () => {
		const longFirstLine = "a".repeat(120);
		await memvidkbBackend.save!(context(), { content: `${longFirstLine}\nsecond line` });
		const [body] = postedRecords();
		const title = String(body?.["title"]);
		expect(title.length).toBe(80);
		expect(title.endsWith("…")).toBe(true);
		expect(title.startsWith("a".repeat(79))).toBe(true);
	});

	it("sends no tags at all when the caller supplies no context", async () => {
		await memvidkbBackend.save!(context(), { content: GATEWAY });
		const [body] = postedRecords();
		expect("tags" in body).toBe(false);
		expect(body?.["title"]).toBe(GATEWAY);
	});
});

describe("autolearn KB sink: same contract through the learn path", () => {
	it("titles the lesson record from the lesson text and tags the capture context", async () => {
		const result = await saveLessonToKb(temp.path(), temp.path(), { memory: GATEWAY, context: CONTEXT });
		expect(result.stored).toBe(1);
		const [body] = postedRecords();
		expect(body?.["content"]).toBe(GATEWAY);
		// The sink's doc once claimed context was "carried as the record's display title";
		// it is a tag now, and the title belongs to the lesson itself.
		expect(body?.["title"]).toBe(GATEWAY);
		expect(body?.["title"]).not.toBe(CONTEXT);
		expect(body?.["tags"]).toEqual([`context=${CONTEXT}`]);
		expect(body?.["originActor"]).toBe(KB_CAPTURE_SOURCE);
	});
});

describe("remember wire contract", () => {
	it("carries lastVerifiedAt, which the deployed service emits on the remember answer", () => {
		// `RememberResponse` (`src/api/records/dto.rs:90-114`) serializes
		// `last_verified_at` at `dto.rs:110-111`; a shape that drops the field would
		// silently hide the verification stamp from every save caller.
		expect(REMEMBER_RESPONSE["lastVerifiedAt"]).toBe("optstring");
	});

	it("parses a remember answer carrying lastVerifiedAt into the typed result", async () => {
		// The stub answers with `lastVerifiedAt: null`; a save that completes is proof the
		// widened shape parses the deployed body rather than refusing it.
		const result = await memvidkbBackend.save!(context(), { content: GATEWAY });
		expect(result).toEqual({ backend: "memvidkb", stored: 1, ids: ["rec-42"] });
	});
});

describe("memvidkb edit update: successor title from the corrected text", () => {
	it("sends the derived title on the supersede wire", async () => {
		const corrected = `${GATEWAY}\nDrain the connections first.`;
		const result = await memvidkbBackend.edit(context(), {
			op: "update",
			id: PRIOR_ID,
			content: corrected,
			expectedCapturedAt: PRIOR_CAPTURED_AT,
		});
		expect(result.status).toBe("updated");
		const sent = requests.find(r => r.method === "POST" && r.path.endsWith("/supersede"));
		expect(sent).toBeDefined();
		const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
		expect(body["content"]).toBe(corrected);
		// Derived from the corrected text — the same rule the remember path applies —
		// not fabricated from the prior id and not left off for the server to invent.
		expect(body["title"]).toBe(GATEWAY);
		expect(body["title"]).not.toBe(PRIOR_ID);
	});

	it("caps the supersede title the same way the remember path caps", async () => {
		const long = "b".repeat(120);
		await memvidkbBackend.edit(context(), {
			op: "update",
			id: PRIOR_ID,
			content: long,
			expectedCapturedAt: PRIOR_CAPTURED_AT,
		});
		const sent = requests.find(r => r.method === "POST" && r.path.endsWith("/supersede"));
		const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
		const title = String(body["title"]);
		// One derivation, two call sites: the cap is not re-implemented here, so a
		// divergence between the two paths would fail this and the remember cap test.
		expect(title.length).toBe(80);
		expect(title.endsWith("…")).toBe(true);
	});

	it("reads the successor back titled, not as a bare id", async () => {
		await memvidkbBackend.edit(context(), {
			op: "update",
			id: PRIOR_ID,
			content: `${GATEWAY}\nSecond line.`,
			expectedCapturedAt: PRIOR_CAPTURED_AT,
		});
		const detail = await inspectRecord(
			{ baseUrl, tokenEnvVar: TOKEN_ENV, token: TOKEN },
			{ track: "dev", recordId: SUCCESSOR_ID },
		);
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		// knowledge-protocol renders `# ${title ?? id}`: a null title on the successor is
		// the silent-drop regression this thread exists to prevent, so the assertion
		// reads the stored record back over the wire instead of trusting the send.
		expect(detail.data.title).toBe(GATEWAY);
		expect(detail.data.title).not.toBeNull();
		expect(detail.data.title).not.toBe(SUCCESSOR_ID);
	});
});
