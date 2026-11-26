/**
 * The read-back precondition on a destructive `memvidkb` edit.
 *
 * `memory_edit update` rewrites a central record wholesale and `forget` erases the document
 * behind it, so both destroy state the caller may never have looked at: a recall or list row
 * is a clipped preview, and the prompt used to promise a read-only fact tier this backend
 * never had — one production `forget` erased a record on the strength of that promise. Both
 * ops therefore refuse unless the caller supplies the `capturedAt` of the row it read, checked
 * against a fresh read of exactly the id named.
 *
 * Hermetic, like `test/memvidkb-verbs-tools.test.ts`: the service is stubbed in-process with
 * `Bun.serve` and every assertion is against a **recorded request**, so "refused" here means
 * the write route was never hit — not merely that the text reads like a refusal.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { memvidkbBackend } from "@oh-my-pi/pi-coding-agent/memvidkb/backend";
import { KNOWLEDGE_ERROR_PREFIX } from "@oh-my-pi/pi-coding-agent/memvidkb/errors";
import type {
	MemoryBackendEditInput,
	MemoryBackendEditResult,
	MemoryBackendOperationContext,
} from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOKEN = "kb-precondition-test-bearer";
const TOKEN_ENV = "MEMVIDKB_PRECONDITION_TEST_TOKEN";
const CONTEXT = "fulton";
const TRACK = "dev";
const RECORD_ID = "rec-42";
const RECORD_URI = "mv2://dev/rec-42";
/** What the stub's record detail reports; the only proof a destructive edit accepts. */
const CAPTURED_AT = "2026-11-16T04:00:00Z";
/** A row that is not this one — a preview of some earlier read, or a row since replaced. */
const STALE_CAPTURED_AT = "2026-11-15T04:00:00Z";
const READ_REF = `knowledge://record/${CONTEXT}/${TRACK}/${RECORD_ID}`;

type Recorded = { method: string; path: string; body: string };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];
let respond: ((request: Recorded) => Response) | undefined;

function detailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: RECORD_ID,
		track: TRACK,
		uri: RECORD_URI,
		title: null,
		tags: [],
		text: "Roll the gateway before the router.",
		originActor: "fulton",
		capturedAt: CAPTURED_AT,
		lastVerifiedAt: "2026-11-16T05:00:00Z",
		derivedFrom: null,
		supersededBy: null,
		...overrides,
	};
}

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
	const doc = {
		version: 1,
		context: CONTEXT,
		baseUrl: `${baseUrl}/`,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: [TRACK, "notes"],
		remember: "on",
		...overrides,
	};
	await Bun.write(`${temp.path()}/.memvidkb`, JSON.stringify(doc));
}

function context(): MemoryBackendOperationContext {
	return { agentDir: temp.path(), cwd: temp.path() };
}

function makeSession(): ToolSession {
	return {
		cwd: temp.path(),
		hasUI: false,
		settings: Settings.isolated({ "memory.backend": "memvidkb" }),
		getSessionFile: () => null,
		getSessionId: () => "precondition-test-session",
		getSessionSpawns: () => null,
		sessionManager: { getCwd: () => temp.path(), getEntries: () => [] },
		getMnemopiSessionState: () => undefined,
	} as unknown as ToolSession;
}

/** The write routes that would have changed central state, had the gate let them through. */
function writeRequests(): Recorded[] {
	return requests.filter(request => request.method === "POST");
}

async function edit(input: MemoryBackendEditInput): Promise<MemoryBackendEditResult> {
	return memvidkbBackend.edit!(context(), input);
}

beforeEach(async () => {
	temp = TempDir.createSync("@memvidkb-precondition-test-");
	requests = [];
	respond = undefined;
	process.env[TOKEN_ENV] = TOKEN;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const recorded: Recorded = {
				method: request.method,
				path: url.pathname,
				body: await request.text(),
			};
			requests.push(recorded);
			if (respond) return respond(recorded);
			if (recorded.path === `/memories/${TRACK}/records/${RECORD_ID}`) return Response.json(detailBody());
			if (recorded.path.endsWith("/supersede")) {
				return Response.json({
					priorId: RECORD_ID,
					newId: "rec-43",
					priorUri: RECORD_URI,
					newUri: "mv2://dev/rec-43",
				});
			}
			if (recorded.path.endsWith("/erase")) {
				return Response.json({ framesRemoved: 2, chunksRemoved: 2, residualFrames: [] });
			}
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	await writeConfig();
});

afterEach(() => {
	respond = undefined;
	server.stop(true);
	resetSettingsForTest();
	delete process.env[TOKEN_ENV];
	void temp.remove();
});

describe("memvidkb edit read-back precondition", () => {
	it("refuses to forget a record nobody read, and never reaches the erase route", async () => {
		const result = await edit({ op: "forget", id: RECORD_ID });

		expect(result.status).toBe("precondition_failed");
		expect(result.message.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(result.message).toContain(READ_REF);
		expect(result.message).toContain("expected_captured_at");
		// The hint has to name the field the caller can actually see: the knowledge:// read
		// prints the proof as `captured:`, never as the wire name `capturedAt`.
		expect(result.message).toContain("captured:");
		// The row is read to check the proof against; the destructive call is never sent.
		expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
			`GET /memories/${TRACK}/records/${RECORD_ID}`,
		]);
	});

	it("refuses to update a record nobody read, and never reaches the supersede route", async () => {
		const result = await edit({
			op: "update",
			id: RECORD_ID,
			content: "Roll the router before the gateway.",
		});

		expect(result.status).toBe("precondition_failed");
		expect(result.message).toContain(READ_REF);
		expect(writeRequests()).toEqual([]);
	});

	it("refuses a proof that is not the row's capturedAt, and names the value the row carries", async () => {
		for (const op of ["update", "forget"] as const) {
			requests = [];
			const result = await edit({
				op,
				id: RECORD_ID,
				content: "Roll the router before the gateway.",
				expectedCapturedAt: STALE_CAPTURED_AT,
			});
			expect(result.status, op).toBe("precondition_failed");
			expect(result.message, op).toContain(CAPTURED_AT);
			expect(result.message, op).toContain(READ_REF);
			expect(result.message, op).toContain("captured:");
			expect(writeRequests(), op).toEqual([]);
		}
	});

	it("refuses a blank proof, which is no proof", async () => {
		const result = await edit({ op: "forget", id: RECORD_ID, expectedCapturedAt: "   " });
		expect(result.status).toBe("precondition_failed");
		expect(result.message).toContain(READ_REF);
		expect(writeRequests()).toEqual([]);
	});

	it("hands the caller a refusal that names the read it must perform, through the tool too", async () => {
		const tool = MemoryEditTool.createIf(makeSession())!;
		for (const params of [
			{ op: "forget" as const, id: RECORD_ID },
			{ op: "update" as const, id: RECORD_ID, content: "Roll the router before the gateway." },
		]) {
			requests = [];
			const result = await tool.execute(`unproven-${params.op}`, params);
			const shown = (result.content as { type: string; text: string }[])[0]?.text ?? "";
			expect((result.details as MemoryBackendEditResult).status, params.op).toBe("precondition_failed");
			expect(shown, params.op).toContain(READ_REF);
			expect(shown, params.op).toContain("expected_captured_at");
			expect(shown, params.op).toContain("captured:");
			expect(writeRequests(), params.op).toEqual([]);
		}
	});

	it("refuses to erase a uri whose read came back as some other record", async () => {
		respond = request =>
			request.path === `/memories/${TRACK}/records/${RECORD_ID}`
				? Response.json(detailBody({ id: "rec-99" }))
				: new Response("ok");

		const result = await edit({ op: "forget", id: RECORD_ID, expectedCapturedAt: CAPTURED_AT });

		expect(result.status).toBe("precondition_failed");
		expect(result.message.startsWith(KNOWLEDGE_ERROR_PREFIX.forbidden)).toBe(true);
		expect(result.message).toContain("rec-99");
		expect(result.message).toContain(READ_REF);
		expect(writeRequests()).toEqual([]);
	});

	it("forgets with a valid proof, erasing the very uri the read returned", async () => {
		const result = await edit({ op: "forget", id: RECORD_ID, expectedCapturedAt: CAPTURED_AT });

		expect(result.status).toBe("forgotten");
		expect(result.message).toContain("2 frame(s)");
		expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
			`GET /memories/${TRACK}/records/${RECORD_ID}`,
			`POST /memories/${TRACK}/erase`,
		]);
		expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({ sourceUri: RECORD_URI });
	});

	it("updates with a valid proof, superseding the row it read", async () => {
		const result = await edit({
			op: "update",
			id: RECORD_ID,
			content: "Roll the router before the gateway.",
			expectedCapturedAt: CAPTURED_AT,
		});

		expect(result.status).toBe("updated");
		expect(result.message).toContain(RECORD_ID);
		expect(result.message).toContain("rec-43");
		expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
			`GET /memories/${TRACK}/records/${RECORD_ID}`,
			`POST /memories/${TRACK}/records/${RECORD_ID}/supersede`,
		]);
	});

	it("reports an unresolvable id as not_found, ordered ahead of the proof gate", async () => {
		respond = () => new Response("no such record", { status: 404 });
		const result = await edit({ op: "forget", id: RECORD_ID });

		// The service answered the prior read with its own `404 not_found:` — an answer about the
		// record, not an outage — so the status is the one the renderer branches on and the one both
		// destructive ops report for the same event (`test/memvidkb-verbs-tools.test.ts:363`,
		// `test/memvidkb-backend.test.ts:574`). What stays pinned here is the ordering: the caller is
		// told the record is absent rather than "you did not read it first", and nothing is written.
		expect(result.status).toBe("not_found");
		expect(result.message).toContain(KNOWLEDGE_ERROR_PREFIX.notFound);
		expect(result.message).toContain("Nothing was erased");
		expect(writeRequests()).toEqual([]);
	});

	it("keeps the consent gate ahead of everything, sending nothing at all", async () => {
		await writeConfig({ remember: "off" });
		for (const input of [
			{ op: "update" as const, id: RECORD_ID, content: "rewritten" },
			{ op: "forget" as const, id: RECORD_ID },
			{ op: "invalidate" as const, id: RECORD_ID },
		]) {
			const result = await edit(input);
			expect(result.status, input.op).toBe("unsupported");
			expect(result.message.startsWith(KNOWLEDGE_ERROR_PREFIX.forbidden), input.op).toBe(true);
		}
		expect(requests).toHaveLength(0);
	});

	it("still reports invalidate as unsupported, with no read and no write", async () => {
		const result = await edit({ op: "invalidate", id: RECORD_ID, replacementId: "rec-43" });
		expect(result.status).toBe("unsupported");
		expect(result.message).toContain("unchanged");
		expect(requests).toHaveLength(0);
	});
});

describe("memory_edit honesty for the memvidkb backend", () => {
	it("exposes the read-back proof as a parameter the model can actually pass", () => {
		const tool = MemoryEditTool.createIf(makeSession())!;
		const ir = (
			tool.parameters as unknown as {
				ir: { props: { key: string; opt: boolean; val: { k: string; desc?: string } }[] };
			}
		).ir;
		const proof = ir.props.find(prop => prop.key === "expected_captured_at");
		expect(proof?.opt).toBe(true);
		expect(proof?.val.k).toBe("string");
		// The parameter hint is the only place the caller learns where the proof comes from,
		// and it has to name the label on the read page rather than the service's field name.
		expect(proof?.val.desc).toContain("captured:");
		expect(proof?.val.desc).toContain("knowledge://record/");
	});

	it("promises no fact tier to a caller on the knowledge service, and points at the read", () => {
		const description = MemoryEditTool.createIf(makeSession())!.description;
		expect(description).toContain("no fact tier");
		expect(description).toContain("chunk frame");
		expect(description).toContain("knowledge://record/<context>/<track>/<record-id>");
		expect(description).toContain("expected_captured_at");
		// The mnemopi-only claims must not reach this backend: they are what made an
		// irreversible erase look like a routine edit of a disposable row.
		expect(description).not.toContain("not_editable");
		expect(description).not.toContain("read-only fact");
	});

	it("keeps the fact-tier promise for the backend that really has one", () => {
		const session = makeSession();
		session.settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const description = MemoryEditTool.createIf(session)!.description;
		expect(description).toContain("not_editable");
		expect(description).not.toContain("no fact tier");
	});
});
