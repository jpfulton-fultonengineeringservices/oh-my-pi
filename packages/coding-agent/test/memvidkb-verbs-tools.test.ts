/**
 * Contract tests for routing the memory tools through the native `memvidkb` backend,
 * plus the `memory_list` verb stock never had.
 *
 * Hermetic: the service is stubbed in-process with `Bun.serve` (same pattern as
 * `test/memvidkb-backend.test.ts`), so every assertion is against a **recorded request**
 * — method, path, query, and body key-set — and against the rendered text the model would
 * see. `KB_LIVE_URL` is never read; nothing here needs a live service.
 *
 * The arm that matters most is the negative one: a tool that quietly served its answer
 * from local files while claiming to use the knowledge service would pass every
 * "does it return text" test. Each routing case therefore asserts the request the
 * knowledge service received, and each failure case asserts both a throw and that the
 * `local` backend's `learned.md` was never created.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LearnTool } from "@oh-my-pi/pi-coding-agent/tools/learn";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryListTool } from "@oh-my-pi/pi-coding-agent/tools/memory-list";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { BUILTIN_TOOL_HELP, BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { MEMORY_BACKEND_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/memory-backend/tool-names";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { MemoryBackendOperationContext } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import type { MemoryBackendEditResult } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { memvidkbBackend } from "@oh-my-pi/pi-coding-agent/memvidkb/backend";
import { KNOWLEDGE_ERROR_PREFIX } from "@oh-my-pi/pi-coding-agent/memvidkb/errors";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

const TOKEN = "kb-parity-test-bearer";
const TOKEN_ENV = "MEMVIDKB_PARITY_TEST_TOKEN";
const RECORD_ID = "rec-42";
const RECORD_URI = "mv2://dev/rec-42";

type Recorded = { method: string; path: string; search: string; body: string };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let closedBaseUrl = "";
let requests: Recorded[] = [];
let respond: ((request: Recorded, index: number) => Response) | undefined;
/**
 * The operator's real agent dir, restored after each test. Every fallback assertion here
 * walks the temp tree, which is only meaningful while `getAgentDir()` points at that tree:
 * left at its default, a genuine local-backend fallback would append `learned.md` under
 * `~/.omp/agent` — the walk would stay empty, the assertion would pass, and the suite
 * would be writing into live user state.
 */
let realAgentDir: string;

function findBody(hitCount: number): unknown {
	return {
		query: "q",
		limit: 10,
		offset: 0,
		total: hitCount,
		mode: "lexical",
		results: Array.from({ length: hitCount }, (_unused, index) => ({
			frameId: `frame-${String(index)}`,
			documentId: "mv2://dev/deploy.md",
			uri: `mv2://dev/deploy.md#chunk-${String(index)}`,
			score: 0.5,
			textSnippet: "Roll the gateway before the router.",
			title: "Deploy",
			timestamp: 1_763_000_000,
		})),
	};
}

function recordBody(): Record<string, unknown> {
	return {
		id: RECORD_ID,
		uri: RECORD_URI,
		frameId: "frame-42",
		track: "dev",
		title: null,
		tags: [],
		originActor: "fulton",
		capturedAt: "2026-11-16T04:00:00Z",
		derivedFrom: null,
	};
}

function pageBody(hitCount: number): unknown {
	return {
		track: "dev",
		total: hitCount,
		limit: 25,
		offset: 0,
		results: Array.from({ length: hitCount }, (_unused, index) => ({
			id: `${RECORD_ID}-${String(index)}`,
			uri: `mv2://dev/rec-${String(index)}`,
			title: index === 0 ? "Gateway order" : null,
			tags: index === 0 ? ["ops", "deploy"] : [],
			originActor: "fulton",
			capturedAt: "2026-11-16T04:00:00Z",
			lastVerifiedAt: index === 0 ? "2026-11-16T05:00:00Z" : null,
			derivedFrom: null,
			supersededBy: null,
			textSnippet: "Roll the gateway first, then the router.",
		})),
	};
}

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
	const doc = {
		version: 1,
		context: "fulton",
		baseUrl: `${baseUrl}/`,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["dev", "notes"],
		remember: "on",
		...overrides,
	};
	await Bun.write(`${temp.path()}/.memvidkb`, JSON.stringify(doc));
}

function context(): MemoryBackendOperationContext {
	return { agentDir: temp.path(), cwd: temp.path() };
}

function makeSession(settings: Settings): ToolSession {
	return {
		cwd: temp.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => "parity-test-session",
		getSessionSpawns: () => null,
		sessionManager: { getCwd: () => temp.path(), getEntries: () => [] },
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => undefined,
	} as unknown as ToolSession;
}

function memvidkbSettings(): Settings {
	// `autolearn.enabled` defaults off and `learn` gates on it: without this the learn cases
	// below would get a null tool and read as a routing failure rather than a settings gap.
	return Settings.isolated({
		"memory.backend": "memvidkb",
		"memories.enabled": false,
		"autolearn.enabled": true,
	});
}

/** Every file under `root` whose name matches, so a stray local write cannot hide. */
function findNamed(root: string, name: string): string[] {
	if (!existsSync(root)) return [];
	const walk = readdirSync(root, { recursive: true, encoding: "utf8" }) as unknown as string[];
	return walk.filter(entry => entry.split("/").pop() === name);
}

function text(result: { content: unknown }): string {
	const first = (result.content as { type: string; text: string }[])[0];
	return first?.text ?? "";
}

/** The tool renders the backend's verdict as text and hands the verdict itself to `details`. */
function editDetails(result: { details?: unknown }): MemoryBackendEditResult {
	return result.details as MemoryBackendEditResult;
}

beforeEach(async () => {
	resetSettingsForTest();
	temp = TempDir.createSync("@memvidkb-parity-test-");
	realAgentDir = getAgentDir();
	setAgentDir(temp.path());
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
				search: url.search,
				body: await request.text(),
			};
			const index = requests.length;
			requests.push(recorded);
			if (respond) return respond(recorded, index);
			if (recorded.path === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
			if (recorded.path.endsWith("/find")) return Response.json(findBody(1));
			if (recorded.path.endsWith("/supersede")) {
				return Response.json({
					priorId: RECORD_ID,
					newId: "rec-43",
					priorUri: RECORD_URI,
					newUri: "mv2://dev/rec-43",
				});
			}
			if (recorded.path.endsWith("/erase")) {
				return Response.json({
					framesRemoved: 2,
					chunksRemoved: 2,
					residualFrames: [],
				});
			}
			if (recorded.path === `/memories/dev/records/${RECORD_ID}`) {
				// A `RecordResponse`, not a `RememberResponse`: the detail body is the only one
				// carrying full `text`, and the client refuses a detail without it.
				return Response.json({
					...recordBody(),
					text: "Roll the gateway before the router.",
					lastVerifiedAt: "2026-11-16T05:00:00Z",
				});
			}
			if (recorded.path.endsWith("/records") && recorded.method === "POST") return Response.json(recordBody());
			if (recorded.path === "/memories/dev/records") return Response.json(pageBody(1));
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	const transient = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
	closedBaseUrl = `http://127.0.0.1:${(transient as unknown as { port: number }).port}`;
	transient.stop(true);
	await writeConfig();
});

afterEach(() => {
	setAgentDir(realAgentDir);
	resetSettingsForTest();
	respond = undefined;
	server.stop(true);
	delete process.env[TOKEN_ENV];
	rmSync(temp.path(), { recursive: true, force: true });
	void temp.remove();
});

describe("memory_list verb", () => {
	it("sends one GET for the default page and renders identity, provenance, and preview", async () => {
		const tool = MemoryListTool.createIf(makeSession(memvidkbSettings()));
		expect(tool).toBeInstanceOf(MemoryListTool);
		const result = await tool!.execute("list-1", {});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.path).toBe("/memories/dev/records");
		expect(requests[0]?.search).toContain("limit=25");
		// A read issues no body at all: no POST, no payload to leak into an audit log.
		expect(requests[0]?.body).toBe("");

		const rendered = text(result);
		expect(rendered).toContain("1 record of 1 in dev");
		expect(rendered).toContain(`id=${RECORD_ID}-0`);
		expect(rendered).toContain("captured=2026-11-16T04:00:00Z");
		expect(rendered).toContain("verified=2026-11-16T05:00:00Z");
		expect(rendered).toContain("origin=fulton");
		expect(rendered).toContain("title=Gateway order");
		expect(rendered).toContain("tags=ops,deploy");
		expect(rendered).toContain("Roll the gateway first, then the router.");
	});

	it("is offered by no other backend, so no other backend gains an unserved verb", () => {
		for (const backend of ["off", "local", "hindsight", "mnemopi", "sharpshooter"] as const) {
			const session = makeSession(Settings.isolated({ "memory.backend": backend, "memories.enabled": false }));
			expect(MemoryListTool.createIf(session), `backend ${backend}`).toBeNull();
		}
		expect(BUILTIN_TOOL_NAMES).toContain("memory_list");
		expect(BUILTIN_TOOL_HELP.memory_list.summary).toBe("List stored long-term memories without searching");
		expect(MEMORY_BACKEND_TOOL_NAMES).toContain("memory_list");
	});

	it("clamps the page instead of forwarding an unbounded limit to the service", async () => {
		await memvidkbBackend.list!(context(), { limit: 5_000 });
		expect(requests[0]?.search).toContain("limit=200");
		await memvidkbBackend.list!(context(), { limit: 0 });
		expect(requests[1]?.search).toContain("limit=1");
		await memvidkbBackend.list!(context(), { offset: -5 });
		expect(requests[2]?.search).toContain("offset=0");
		await memvidkbBackend.list!(context(), {});
		// Neither bound supplied: the service picks the page, and no empty params go on the wire.
		expect(requests[3]?.search).toBe("");
	});

	it("keeps listing while central remember is off, because reads and writes are separate gates", async () => {
		await writeConfig({ remember: "off" });
		const result = await memvidkbBackend.list!(context(), { limit: 5 });
		expect(result.count).toBe(1);
		expect(result.items[0]?.id).toBe(`${RECORD_ID}-0`);
		expect(requests.every(request => request.method === "GET")).toBe(true);
	});

	it("refuses a context with no permitted track without contacting the service", async () => {
		await writeConfig({ tracks: [] });
		const result = await memvidkbBackend.list!(context(), {});
		expect(result.count).toBe(0);
		expect(result.items).toEqual([]);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.forbidden)).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("throws instead of rendering an outage as an empty inventory", async () => {
		baseUrl = closedBaseUrl;
		await writeConfig();
		const tool = MemoryListTool.createIf(makeSession(memvidkbSettings()))!;
		await expect(tool.execute("list-down", {})).rejects.toThrow(KNOWLEDGE_ERROR_PREFIX.unreachable);
	});

	it("renders a genuinely empty page as empty, not as a failure", async () => {
		respond = () => Response.json(pageBody(0));
		const tool = MemoryListTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await tool.execute("list-empty", {});
		expect(text(result)).toContain("No records stored in dev.");
	});

	it("reports an invalid configuration as a prefixed refusal, never as an empty listing", async () => {
		rmSync(`${temp.path()}/.memvidkb`, { force: true });
		const result = await memvidkbBackend.list!(context(), {});
		expect(result.count).toBe(0);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.invalidConfig)).toBe(true);
	});
});

describe("memory_edit verbs", () => {
	it("supersedes by id with only the fields the route documents", async () => {
		const tool = MemoryEditTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await tool.execute("edit-update", {
			op: "update",
			id: RECORD_ID,
			content: "Roll the router before the gateway.",
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.path).toBe(`/memories/dev/records/${RECORD_ID}/supersede`);
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["content", "originActor"]);
		expect(body["content"]).toBe("Roll the router before the gateway.");
		expect(text(result)).toContain(RECORD_ID);
		expect(text(result)).toContain("rec-43");
	});

	it("resolves the id to its uri before erasing, so a delete cannot address the wrong row", async () => {
		const tool = MemoryEditTool.createIf(makeSession(memvidkbSettings()))!;
		await tool.execute("edit-forget", { op: "forget", id: RECORD_ID });

		expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
			`GET /memories/dev/records/${RECORD_ID}`,
			"POST /memories/dev/erase",
		]);
		const erase = JSON.parse(requests[1]?.body ?? "{}") as Record<string, unknown>;
		expect(Object.keys(erase)).toEqual(["sourceUri"]);
		expect(erase["sourceUri"]).toBe(RECORD_URI);
	});

	it("refuses to erase when the id cannot be resolved, instead of guessing a source", async () => {
		respond = request =>
			request.path === `/memories/dev/records/${RECORD_ID}`
				? new Response("no such record", { status: 404 })
				: new Response("ok");
		const tool = MemoryEditTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await tool.execute("edit-forget-missing", { op: "forget", id: RECORD_ID });
		expect(editDetails(result).status).toBe("failed");
		expect(editDetails(result).message.startsWith(KNOWLEDGE_ERROR_PREFIX.notFound)).toBe(true);
		expect(requests.filter(request => request.path.endsWith("/erase"))).toHaveLength(0);
	});

	it("reports invalidate as unsupported and touches nothing", async () => {
		const tool = MemoryEditTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await tool.execute("edit-invalidate", { op: "invalidate", id: RECORD_ID });
		expect(editDetails(result).status).toBe("unsupported");
		expect(text(result)).toContain("unchanged");
		expect(requests).toHaveLength(0);
	});

	it("refuses every edit while remember is off, without a request", async () => {
		await writeConfig({ remember: "off" });
		const tool = MemoryEditTool.createIf(makeSession(memvidkbSettings()))!;
		for (const params of [
			{ op: "update" as const, id: RECORD_ID, content: "rewritten" },
			{ op: "forget" as const, id: RECORD_ID },
			{ op: "invalidate" as const, id: RECORD_ID },
		]) {
			const result = await tool.execute(`edit-off-${params.op}`, params);
			expect(editDetails(result).status, params.op).toBe("unsupported");
			expect(editDetails(result).message.startsWith(KNOWLEDGE_ERROR_PREFIX.forbidden), params.op).toBe(true);
		}
		expect(requests).toHaveLength(0);
	});

	it("needs write approval before it will touch a central track", () => {
		const tool = MemoryEditTool.createIf(makeSession(memvidkbSettings()))!;
		expect(tool.approval({ op: "update", id: RECORD_ID })).toBe("write");
		expect(tool.approval({ op: "forget", id: RECORD_ID })).toBe("write");
		// An op that provably changes nothing does not need the write tier.
		expect(tool.approval({ op: "invalidate", id: RECORD_ID })).toBe("read");
	});

	it("stays read-only approved for the backend that started the tool", () => {
		const tool = MemoryEditTool.createIf(
			makeSession(Settings.isolated({ "memory.backend": "mnemopi", "memories.enabled": false })),
		)!;
		expect(tool.approval({ op: "forget", id: "anything" })).toBe("read");
	});
});

describe("memory tools route to the knowledge service", () => {
	it("retain posts one record per item and reports the id the service assigned", async () => {
		const tool = MemoryRetainTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await tool.execute("retain-1", {
			items: [{ content: "The gateway must be restarted before the router.", context: "deploy" }],
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.path).toBe("/memories/dev/records");
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(body["content"]).toBe("The gateway must be restarted before the router.");
		// `context` has no wire counterpart; the backend carries it as the record's display `title`.
		expect(body["title"]).toBe("deploy");
		expect(body["context"]).toBeUndefined();
		expect(text(result)).toBe("1 memory stored.");
		// The tell-tale of a silent fallback: the local backend appends lessons to
		// learned.md under the agent dir. A routed retain never creates it.
		expect(findNamed(temp.path(), "learned.md")).toEqual([]);
	});

	it("retain refuses a global item instead of filing it as project memory", async () => {
		const tool = MemoryRetainTool.createIf(makeSession(memvidkbSettings()))!;
		await expect(
			tool.execute("retain-global", { items: [{ content: "cross-project fact", scope: "global" }] }),
		).rejects.toThrow(/Global memory scope is not available with the memvidkb/);
		expect(requests).toHaveLength(0);
		expect(findNamed(temp.path(), "learned.md")).toEqual([]);
	});

	it("retain stops the batch at the first refusal and names what it kept", async () => {
		respond = (request, index) =>
			index === 0 ? Response.json(recordBody()) : new Response("gateway refused", { status: 503 });
		const tool = MemoryRetainTool.createIf(makeSession(memvidkbSettings()))!;
		const error = await tool
			.execute("retain-partial", { items: [{ content: "kept" }, { content: "lost" }, { content: "untried" }] })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("item 2 of 3");
		expect(message).toContain(`kept: item 1 (id ${RECORD_ID})`);
		expect(message).toContain("Later items were not attempted.");
		expect(requests).toHaveLength(2);
	});

	it("recall searches the track and renders id, source, score, and text", async () => {
		const tool = MemoryRecallTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await tool.execute("recall-1", { query: "gateway restart order" });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.path).toBe("/memories/dev/find");
		expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ query: "gateway restart order" });
		const rendered = text(result);
		expect(rendered).toMatch(/^Found 1 relevant memory \(as of .+ UTC\):/);
		expect(rendered).toContain("id=frame-0");
		expect(rendered).toContain("source=mv2://dev/deploy.md#chunk-0");
		expect(rendered).toContain("score=0.5000");
		expect(rendered).toContain("Roll the gateway before the router.");
	});

	it("recall reports zero hits as no matches, and an outage as a throw", async () => {
		respond = () => Response.json(findBody(0));
		const empty = await MemoryRecallTool.createIf(makeSession(memvidkbSettings()))!.execute("recall-empty", {
			query: "nothing",
		});
		expect(text(empty)).toBe("No relevant memories found.");
		expect(empty.useless).toBe(true);

		baseUrl = closedBaseUrl;
		await writeConfig();
		const down = MemoryRecallTool.createIf(makeSession(memvidkbSettings()))!;
		await expect(down.execute("recall-down", { query: "anything" })).rejects.toThrow(
			KNOWLEDGE_ERROR_PREFIX.unreachable,
		);
	});

	it("reflect frames retrieved records instead of inventing a synthesis", async () => {
		const tool = MemoryReflectTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await tool.execute("reflect-1", { query: "restart order", context: "incident" });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.path).toBe("/memories/dev/find");
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(body["query"]).toContain("restart order");
		expect(body["query"]).toContain("incident");
		expect(body["limit"]).toBe(12);
		const rendered = text(result);
		expect(rendered).toContain("Based on recalled memories:");
		expect(rendered).toContain("(mv2://dev/deploy.md#chunk-0)");
	});

	it("reflect says so when there is nothing to reflect on", async () => {
		respond = () => Response.json(findBody(0));
		const result = await MemoryReflectTool.createIf(makeSession(memvidkbSettings()))!.execute("reflect-empty", {
			query: "anything",
		});
		expect(text(result)).toBe("No relevant information found to reflect on.");
	});

	it("learn stores the lesson centrally and never falls back to learned.md", async () => {
		const learn = LearnTool.createIf(makeSession(memvidkbSettings()))!;
		const result = await learn.execute("learn-1", {
			memory: "Roll the gateway before the router; the reverse order drops in-flight requests.",
			context: "deploy runbook",
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.path).toBe("/memories/dev/records");
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(String(body["content"])).toContain("Roll the gateway before the router");
		expect(body["source"]).toBeUndefined();
		expect(text(result)).toContain("Lesson stored");
		expect(text(result)).toContain(RECORD_ID);
		expect(findNamed(temp.path(), "learned.md")).toEqual([]);
	});

	it("learn needs the write approval tier for a central track", () => {
		const learn = LearnTool.createIf(makeSession(memvidkbSettings()))!;
		expect(learn.approval({ memory: "a lesson" })).toBe("write");
	});

	it("learn refuses a global lesson and stores nothing anywhere", async () => {
		const learn = LearnTool.createIf(makeSession(memvidkbSettings()))!;
		await expect(learn.execute("learn-global", { memory: "cross-project lesson", scope: "global" })).rejects.toThrow(
			/Global memory scope is not available/,
		);
		expect(requests).toHaveLength(0);
		expect(findNamed(temp.path(), "learned.md")).toEqual([]);
	});

	it("never teaches a knowledge:// URI that the resolver would reject", async () => {
		// `src/internal-urls/knowledge-protocol.ts` parses only
		// `knowledge://record/<context>/<track>/<record-id>` and
		// `knowledge://track/<context>/<track>`; any other spelling answers
		// `invalid_knowledge_uri`. Nothing behavioural can catch a malformed one — the
		// agent just gets a refusal after following the instructions — so every surface
		// that mentions the scheme is pinned here, source and docs alike.
		// The shape rejected is the scheme followed by a placeholder: a documented
		// generic reference to the scheme (`` `knowledge://` reader ``) is prose, not a
		// taught URI, so it stays legal.
		const surfaces: Record<string, string> = {
			"memory-list prompt": await Bun.file(new URL("../src/prompts/tools/memory-list.md", import.meta.url)).text(),
			"memory-list doc": await Bun.file(new URL("../../../docs/tools/memory-list.md", import.meta.url)).text(),
			"memvidkb backend": await Bun.file(new URL("../src/memvidkb/backend.ts", import.meta.url)).text(),
		};
		for (const [name, text] of Object.entries(surfaces)) {
			// `\x3c` rather than the literal character: the placeholder is what a
			// hand-written URI starts with, and an escape keeps this file independent of
			// any tool that rewrites angle brackets in transit.
			const malformed = text.match(/knowledge:\/\/(?!record\/|track\/)\x3c/g) ?? [];
			expect(malformed, `${name} teaches only resolvable knowledge URIs`).toEqual([]);
		}
	});
});
