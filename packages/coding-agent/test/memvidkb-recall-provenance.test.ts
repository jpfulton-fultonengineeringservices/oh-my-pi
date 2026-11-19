/**
 * Recall provenance: every `recall` hit must be addressable, not merely readable.
 *
 * The defect this pins: `recall` rendered `#N id= source= score=` and nothing else, and
 * the id it printed was the hit's `frameId`. `memory_edit` and `memory_list` take
 * **record** ids, so the handle the model was handed was often one no later call could
 * resolve, and nothing on the page named the track or context the row lived in. A hit
 * therefore has to carry, in the model-visible text and again in `details`: the track, the
 * context, and a `knowledge://record/<context>/<track>/<record-id>` pointer that reads the
 * whole stored text back — plus a signal when the snippet is the service's clipped preview
 * rather than the row.
 *
 * Hermetic in the same shape as `test/memvidkb-verbs-tools.test.ts`: the service is
 * `Bun.serve` on an ephemeral port, the client is never mocked, and `.memvidkb` is written
 * into a fresh temp workspace per test so the config reader is exercised too.
 */

import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { KnowledgeProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/knowledge-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { MemoryBackendSearchItem } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOKEN = "kb-provenance-test-bearer";
const TOKEN_ENV = "MEMVIDKB_PROVENANCE_TEST_TOKEN";
const CONTEXT = "fulton";
const TRACK = "dev";

/** A find hit as the service's `SearchResult` reports it — no `track`, no record id. */
type StubHit = {
	frameId: string;
	uri: string;
	textSnippet: string;
	title?: string;
	timestamp?: number;
	score?: number;
};

const RECORD_HIT: StubHit = {
	frameId: "frame-9",
	uri: "mv2://dev/records/rec-42",
	textSnippet: "Roll the gateway before the router.",
	title: "Gateway order",
	timestamp: 1_763_000_000,
};

const CHUNK_HIT: StubHit = {
	frameId: "frame-10",
	uri: "mv2://dev/records/rec-7/chunk-3",
	textSnippet: "Drain the router before the gateway.",
	title: "Router drain",
	timestamp: 1_763_000_001,
};

/** A document chunk: no route takes its frame id, so it must stay a frame id. */
const DOCUMENT_HIT: StubHit = {
	frameId: "frame-11",
	uri: "mv2://dev/deploy.md#chunk-0",
	textSnippet: "The runbook says gateway first.",
	title: "Deploy",
	timestamp: 1_763_000_002,
};

/** Exactly the service's `SNIPPET_CHARS` ceiling, so it reads as clipped. */
const CLIPPED_SNIPPET = "x".repeat(200);
const SHORT_SNIPPET = "Roll the gateway before the router.";

/**
 * The whole stored row, longer than any snippet and worded differently on purpose: a
 * pointer that resolves is the only way a caller reaches this text.
 */
const FULL_RECORD_TEXT =
	"Roll the gateway before the router, then drain the router before the gateway on the way back down.";

type Recorded = { method: string; path: string; body: string };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];
let hits: StubHit[] = [RECORD_HIT];

function findBody(): unknown {
	return {
		query: "q",
		limit: 10,
		offset: 0,
		total: hits.length,
		mode: "hybrid",
		results: hits.map(hit => ({
			frameId: hit.frameId,
			documentId: hit.uri.split("#")[0],
			uri: hit.uri,
			score: hit.score ?? 0.5,
			textSnippet: hit.textSnippet,
			title: hit.title ?? null,
			timestamp: hit.timestamp ?? 0,
		})),
	};
}

async function writeConfig(): Promise<void> {
	const doc = {
		version: 1,
		context: CONTEXT,
		// Trailing slash on purpose: the loader normalises it, and the pointer is built from
		// the resolved context, not the file's spelling.
		baseUrl: `${baseUrl}/`,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: [TRACK, "notes"],
		remember: "on",
	};
	await Bun.write(`${temp.path()}/.memvidkb`, JSON.stringify(doc));
}

function makeSession(settings: Settings): ToolSession {
	return {
		cwd: temp.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => "provenance-test-session",
		getSessionSpawns: () => null,
		sessionManager: { getCwd: () => temp.path(), getEntries: () => [] },
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => undefined,
	} as unknown as ToolSession;
}

function settings(): Settings {
	return Settings.isolated({ "memory.backend": "memvidkb", "memories.enabled": false });
}

async function recall(): Promise<{ text: string; details: { items?: MemoryBackendSearchItem[] } }> {
	const tool = MemoryRecallTool.createIf(makeSession(settings()))!;
	const result = await tool.execute("recall-provenance", { query: "gateway restart order" });
	const first = (result.content as { type: string; text: string }[])[0];
	return { text: first?.text ?? "", details: result.details as { items?: MemoryBackendSearchItem[] } };
}

beforeEach(async () => {
	temp = TempDir.createSync("@memvidkb-recall-provenance-");
	requests = [];
	hits = [RECORD_HIT];
	process.env[TOKEN_ENV] = TOKEN;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const recorded: Recorded = { method: request.method, path: url.pathname, body: await request.text() };
			requests.push(recorded);
			if (recorded.path === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
			if (recorded.path.endsWith("/find")) return Response.json(findBody());
			if (recorded.path === `/memories/${TRACK}/records/rec-42`) {
				// A `RecordResponse`: the detail route is the one carrying full `text`, and the
				// protocol handler is what turns the emitted pointer into this call.
				return Response.json({
					id: "rec-42",
					track: TRACK,
					uri: RECORD_HIT.uri,
					title: RECORD_HIT.title,
					tags: ["ops"],
					text: FULL_RECORD_TEXT,
					originActor: "fulton",
					capturedAt: "2026-11-16T04:00:00Z",
					lastVerifiedAt: null,
					derivedFrom: null,
					supersededBy: null,
				});
			}
			if (recorded.path.endsWith("/supersede")) {
				return Response.json({
					priorId: "rec-42",
					newId: "rec-43",
					priorUri: RECORD_HIT.uri,
					newUri: "mv2://dev/records/rec-43",
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	await writeConfig();
});

afterEach(() => {
	resetSettingsForTest();
	delete process.env[TOKEN_ENV];
	server.stop(true);
	rmSync(temp.path(), { recursive: true, force: true });
	temp.remove();
});

describe("recall renders hit provenance", () => {
	it("renders track, context and a knowledge:// record pointer, and carries them in details", async () => {
		const { text, details } = await recall();

		// The row is addressable from the page alone: scope, then the pointer that reads
		// the whole text back.
		expect(text).toContain("track=dev");
		expect(text).toContain("context=fulton");
		expect(text).toContain("read: knowledge://record/fulton/dev/rec-42");
		// The id the model gets is the record id, not the frame id the DTO carries.
		expect(text).toContain("id=rec-42");
		expect(text).not.toContain("id=frame-9");
		expect(text).toContain("Roll the gateway before the router.");
		// `memory://` is the retired local backends' scheme and throws here.
		expect(text).not.toContain("memory://");

		// Same data in machine-readable form — `details` used to be `{}`.
		expect(details.items).toHaveLength(1);
		const item = details.items?.[0];
		expect(item?.id).toBe("rec-42");
		expect(item?.track).toBe("dev");
		expect(item?.context).toBe("fulton");
		expect(item?.pointer).toBe("knowledge://record/fulton/dev/rec-42");
		expect(item?.source).toBe("mv2://dev/records/rec-42");
		expect(JSON.stringify(details)).not.toContain("memory://");
		// The two surfaces carry the identical string: a caller that copies the pointer out
		// of the rendered text and one that reads `details` address the same row.
		const renderedPointer = /read:\s+(\S+)/.exec(text)?.[1];
		expect(renderedPointer).toBe(item?.pointer);
	});

	it("emits a pointer the knowledge protocol handler actually resolves", async () => {
		// A malformed pointer is behaviourally invisible — the model just gets a refusal after
		// following the instruction — so the emitted string is fed back through the same
		// resolver the harness uses, against the stub service.
		const { text, details } = await recall();
		// `?? ""` only satisfies the resolver's non-optional parameter; the assertion on the
		// next line is what proves the backend emitted a pointer at all.
		const pointer = details.items?.[0]?.pointer ?? "";
		expect(pointer).toBe("knowledge://record/fulton/dev/rec-42");

		const resource = await new KnowledgeProtocolHandler().resolve(parseInternalUrl(pointer), {
			cwd: temp.path(),
		});
		expect(resource.url).toBe(pointer);
		expect(resource.notes ?? []).not.toContain("invalid_knowledge_uri");
		// The round trip reached the detail route, i.e. the whole row, not the snippet.
		expect(resource.content).toContain(FULL_RECORD_TEXT);
		expect(requests.some(request => request.path === `/memories/dev/records/rec-42`)).toBe(true);
		// And it is the row the hit came from: same track and context the hit named.
		expect(text).toContain("read: knowledge://record/fulton/dev/rec-42");
	});

	it("makes the recalled id addressable by the write verbs", async () => {
		const { details } = await recall();
		// `?? ""` keeps the handle non-optional for the typed tool call below; the
		// assertion right after it is what proves the backend actually produced one.
		const id = details.items?.[0]?.id ?? "";
		expect(id).toBe("rec-42");

		// The proof the id is record-addressable: the same string drives a real edit route.
		const tool = MemoryEditTool.createIf(makeSession(settings()))!;
		await tool.execute("edit-from-recall", { op: "update", id, content: "Roll the router before the gateway." });
		const supersede = requests.find(request => request.path.endsWith("/supersede"));
		expect(supersede?.path).toBe("/memories/dev/records/rec-42/supersede");
	});

	it("derives the record id from a chunk uri, which addresses the same record", async () => {
		hits = [CHUNK_HIT];
		const { text, details } = await recall();

		expect(text).toContain("id=rec-7");
		expect(text).toContain("read: knowledge://record/fulton/dev/rec-7");
		expect(details.items?.[0]?.id).toBe("rec-7");
		expect(details.items?.[0]?.pointer).toBe("knowledge://record/fulton/dev/rec-7");
	});

	it("falls back to the frame id when the uri addresses no record, and says so", async () => {
		hits = [DOCUMENT_HIT];
		const { text, details } = await recall();

		// A document chunk has no record handle to give; inventing one would hand the model
		// an id the next call cannot resolve.
		expect(text).toContain("id=frame-11");
		expect(text).not.toContain("knowledge://");
		expect(text).toContain("read: none");
		expect(text).toContain("frame id");

		const item = details.items?.[0];
		expect(item?.id).toBe("frame-11");
		expect(item?.pointer).toBeUndefined();
		// Scope still travels — the row is locatable even when it is not editable.
		expect(item?.track).toBe("dev");
		expect(item?.context).toBe("fulton");
	});

	it("flags a server-clipped snippet with the ceiling it was measured against", async () => {
		hits = [{ ...RECORD_HIT, textSnippet: CLIPPED_SNIPPET }];
		const { text, details } = await recall();

		expect(text).toContain("clippedAt=200");
		expect(details.items?.[0]?.truncated).toBe(true);
		expect(details.items?.[0]?.snippetLimit).toBe(200);
	});

	it("does not claim clipping for a snippet under the ceiling", async () => {
		hits = [{ ...RECORD_HIT, textSnippet: SHORT_SNIPPET }];
		const { text, details } = await recall();

		expect(text).not.toContain("clippedAt=");
		expect(details.items?.[0]?.truncated).toBe(false);
	});

	it("keeps every hit's own scope and pointer in a mixed page", async () => {
		hits = [RECORD_HIT, CHUNK_HIT, DOCUMENT_HIT];
		const { text, details } = await recall();

		expect(text).toContain("read: knowledge://record/fulton/dev/rec-42");
		expect(text).toContain("read: knowledge://record/fulton/dev/rec-7");
		expect(text).toContain("read: none");
		expect(details.items?.map(item => item.id)).toEqual(["rec-42", "rec-7", "frame-11"]);
		expect(details.items?.every(item => item.track === "dev" && item.context === "fulton")).toBe(true);
	});
});
