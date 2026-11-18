/**
 * Hermetic tests for the native memvidkb memory backend.
 *
 * The service is stubbed in-process with `Bun.serve` — the pattern copied from
 * `test/hindsight-outbox.test.ts:35-64` — and the client is never mocked: each arm drives
 * real `fetch` traffic through `src/memvidkb/client.ts` so the client is exercised rather
 * than asserted away. `.memvidkb` is written into a fresh temp workspace per test, so the
 * config path is exercised through the fork's real reader as well. Ports are always
 * ephemeral; 8080 is never used.
 */

import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { memvidkbBackend } from "../src/memvidkb/backend";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { resolveMemoryBackend } from "../src/memory-backend/resolve";
import { RETIRED_MEMORY_BACKENDS, retiredMemoryBackendMessage } from "../src/memory-backend/settings";
import type { MemoryBackendOperationContext, MemoryBackendSaveInput } from "../src/memory-backend/types";
import { KNOWLEDGE_ERROR_PREFIX } from "../src/memvidkb/errors";

const TOKEN = "kb-backend-test-bearer";
const TOKEN_ENV = "MEMVIDKB_BACKEND_TEST_TOKEN";

type Recorded = { method: string; path: string; search: string; body: string; authorization: string | null };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let closedBaseUrl = "";
let requests: Recorded[] = [];
let respond: ((request: Recorded) => Response) | undefined;

function findBody(timestamp: number, hits = 1): unknown {
	return {
		query: "q",
		limit: 10,
		offset: 0,
		total: hits,
		mode: "lexical",
		results: Array.from({ length: hits }, (_unused, index) => ({
			frameId: `frame-${String(index)}`,
			documentId: "mv2://dev/deploy.md",
			uri: `mv2://dev/deploy.md#chunk-${String(index)}`,
			score: 0.5,
			textSnippet: "Roll the gateway before the router.",
			title: "Deploy",
			timestamp,
		})),
	};
}

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
	const doc = {
		version: 1,
		context: "fulton",
		// Trailing slash on purpose: the loader must normalise it, or every route doubles up.
		baseUrl: `${baseUrl}/`,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["dev", "notes"],
		remember: "on",
		...overrides,
	};
	await Bun.write(`${temp.path()}/.memvidkb`, JSON.stringify(doc));
}

function dropConfig(): void {
	rmSync(`${temp.path()}/.memvidkb`, { force: true });
}

function context(): MemoryBackendOperationContext {
	return { agentDir: temp.path(), cwd: temp.path() };
}

beforeEach(async () => {
	temp = TempDir.createSync("@memvidkb-backend-test-");
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
				authorization: request.headers.get("authorization"),
				body: await request.text(),
			};
			requests.push(recorded);
			if (respond) return respond(recorded);
			if (recorded.path === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
			if (recorded.path.endsWith("/find")) return Response.json(findBody(1_763_000_000));
			if (recorded.path.endsWith("/records") && recorded.method === "POST") {
				return Response.json({
					id: "rec-42",
					uri: "mv2://dev/rec-42",
					frameId: "frame-42",
					track: "dev",
					title: null,
					tags: [],
					originActor: "fulton",
					capturedAt: "2026-11-16T04:00:00Z",
					derivedFrom: null,
				});
			}
			if (recorded.path.endsWith("/records")) {
				return Response.json({
					track: "dev",
					total: 1,
					limit: 5,
					offset: 0,
					results: [
						{
							id: "rec-42",
							uri: "mv2://dev/rec-42",
							title: null,
							tags: [],
							originActor: "fulton",
							capturedAt: "2026-11-16T04:00:00Z",
							lastVerifiedAt: "2026-11-16T05:00:00Z",
							derivedFrom: null,
							supersededBy: null,
							textSnippet: "Roll the gateway first.",
						},
					],
				});
			}
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
	respond = undefined;
	server.stop(true);
	delete process.env[TOKEN_ENV];
	void temp.remove();
});

describe("memvidkb backend selection", () => {
	beforeEach(() => resetSettingsForTest());
	afterEach(() => resetSettingsForTest());

	it("resolves to memvidkb, leaves off alone, and refuses the retired backends", async () => {
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "memvidkb" }))).id).toBe("memvidkb");
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "off" }))).id).toBe("off");
		// The retirement made the knowledge service the default, so an unset value now
		// selects it rather than leaving the session memoryless.
		expect((await resolveMemoryBackend(Settings.isolated({}))).id).toBe("memvidkb");
		// The retired ids no longer resolve: they raise rather than being replaced by
		// whichever backend the default happens to name.
		for (const retired of RETIRED_MEMORY_BACKENDS) {
			await expect(resolveMemoryBackend(Settings.isolated({ "memory.backend": retired }))).rejects.toThrow(
				retiredMemoryBackendMessage(retired),
			);
		}
	});
});

describe("memvidkb backend search", () => {
	it("maps a find page onto search items", async () => {
		const result = await memvidkbBackend.search!(context(), "deploy runbook");
		expect(result.backend).toBe("memvidkb");
		expect(result.query).toBe("deploy runbook");
		expect(result.count).toBe(1);
		expect(result.items[0]).toEqual({
			id: "frame-0",
			content: "Roll the gateway before the router.",
			source: "mv2://dev/deploy.md#chunk-0",
			timestamp: new Date(1_763_000_000 * 1000).toISOString(),
			score: 0.5,
		});
		// One request, on the route the service registers, with the slash-suffixed base fixed up.
		expect(requests).toHaveLength(1);
		expect(requests[0]?.path).toBe("/memories/dev/find");
		// The bearer really travels: a stub that accepted anything would not catch a client
		// that quietly stopped sending it.
		expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
		expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ query: "deploy runbook" });
	});

	it("leaves a frame with no createdAt undated instead of claiming 1970", async () => {
		respond = () => Response.json(findBody(0));
		const result = await memvidkbBackend.search!(context(), "q");
		expect(result.count).toBe(1);
		expect(result.items[0]?.timestamp).toBeUndefined();
	});

	it("clips an absurd limit to the documented ceiling and floors it at one", async () => {
		respond = () => Response.json(findBody(1, 0));
		await memvidkbBackend.search!(context(), "q", { limit: 5_000 });
		expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ limit: 50 });
		await memvidkbBackend.search!(context(), "q", { limit: 0 });
		expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({ limit: 1 });
	});

	it("refuses an empty query before the wire", async () => {
		const result = await memvidkbBackend.search!(context(), "   ");
		expect(result.count).toBe(0);
		expect(result.items).toEqual([]);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("reports a transport failure as unreachable, never as an empty answer", async () => {
		baseUrl = closedBaseUrl;
		await writeConfig();
		const result = await memvidkbBackend.search!(context(), "q");
		expect(result.count).toBe(0);
		expect(result.items).toEqual([]);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.unreachable)).toBe(true);
		expect(result.message).toContain("retrieval outage, not a zero-result answer");
	});

	it("reports a malformed success body as unavailable", async () => {
		respond = () => new Response("<html>gateway</html>", { status: 200 });
		const result = await memvidkbBackend.search!(context(), "q");
		expect(result.count).toBe(0);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
	});

	it("surfaces a missing or blank configuration as a clean error rather than a silent no-op", async () => {
		dropConfig();
		const result = await memvidkbBackend.search!(context(), "q");
		expect(result.count).toBe(0);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.invalidConfig)).toBe(true);
		expect(result.message).toContain("CONFIG_NOT_FOUND");
		expect(requests).toHaveLength(0);
	});

	it("refuses to go unauthenticated when the bearer env var is empty, blank, or unset", async () => {
		// Same contract for all three arms: never an unauthenticated request, and never a
		// recall that quietly returns nothing. Where they differ is the layer — "empty" and
		// "unset" are refused by the loader (mirroring both readers), "blank" is accepted at
		// load like the deployed reader accepts it and refused at the send boundary in
		// src/memvidkb/bearer.ts. Either way nothing reaches the socket, which is what
		// `requests` measures, and the message names the variable rather than the value.
		for (const arm of ["empty", "blank", "unset"] as const) {
			requests = [];
			if (arm === "empty") process.env[TOKEN_ENV] = "";
			else if (arm === "blank") process.env[TOKEN_ENV] = "   ";
			else delete process.env[TOKEN_ENV];
			const result = await memvidkbBackend.search!(context(), "q");
			expect(result.count).toBe(0);
			expect(result.items).toEqual([]);
			expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.invalidConfig)).toBe(true);
			expect(result.message).toContain(TOKEN_ENV);
			expect(result.message).toContain("TOKEN_ENV_UNSET");
			expect(requests).toHaveLength(0);
		}
	});

	it("refuses a context with no permitted track without contacting the service", async () => {
		await writeConfig({ tracks: [] });
		const result = await memvidkbBackend.search!(context(), "q");
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.forbidden)).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("reports an aborted recall as cancelled rather than as a service fault", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await memvidkbBackend.search!(context(), "q", { signal: controller.signal });
		expect(result.count).toBe(0);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(result.message).toContain("aborted");
	});
});

describe("memvidkb backend save", () => {
	function input(overrides: Partial<MemoryBackendSaveInput> = {}): MemoryBackendSaveInput {
		return { content: "Roll the gateway before the router.", ...overrides };
	}

	it("stores one record and reports the id the service assigned", async () => {
		const result = await memvidkbBackend.save!(context(), input({ context: "preference" }));
		expect(result).toEqual({ backend: "memvidkb", stored: 1, ids: ["rec-42"] });
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(requests[0]?.path).toBe("/memories/dev/records");
		expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
		expect(body["content"]).toBe("Roll the gateway before the router.");
		// No producer named: the backend claims itself. Never the bound context — that is a
		// workspace label, and the route documents originActor as caller-named provenance
		// (`src/api/records/dto.rs:30-33`), never a value invented from configuration.
		expect(body["originActor"]).toBe("agent:omp-memvidkb-backend");
		expect(body["title"]).toBe("preference");
	});

	it("carries an explicit source as the producing actor", async () => {
		await memvidkbBackend.save!(context(), input({ source: "j.patrickfulton" }));
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(body["originActor"]).toBe("j.patrickfulton");
	});

	it("never sends importance, which the route does not document", async () => {
		const result = await memvidkbBackend.save!(context(), input({ importance: 0.9 }));
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect("importance" in body).toBe(false);
		// Dropped silently would read as stored, so the caller is told on the result.
		expect(result.message).toContain("importance");
	});

	it("refuses every write while .memvidkb sets remember to off", async () => {
		await writeConfig({ remember: "off" });
		const result = await memvidkbBackend.save!(context(), input());
		expect(result.stored).toBe(0);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.forbidden)).toBe(true);
		expect(result.message).toContain("Nothing was sent, queued, or retried locally");
		expect(requests).toHaveLength(0);
	});

	it("reports an unreachable write as unstored", async () => {
		baseUrl = closedBaseUrl;
		await writeConfig();
		const result = await memvidkbBackend.save!(context(), input());
		expect(result.stored).toBe(0);
		expect(result.ids).toEqual([]);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.unreachable)).toBe(true);
		expect(result.message).toContain("Nothing was stored, queued, or retried locally");
	});

	it("refuses an empty content before the wire", async () => {
		const result = await memvidkbBackend.save!(context(), input({ content: "  " }));
		expect(result.stored).toBe(0);
		expect(result.message?.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(requests).toHaveLength(0);
	});
});

describe("memvidkb backend status, prompts, and reports", () => {
	it("reports an active backend when the service answers healthz", async () => {
		const status = await memvidkbBackend.status!(context());
		expect(status).toMatchObject({
			backend: "memvidkb",
			active: true,
			writable: true,
			searchable: true,
			scope: "fulton",
			database: baseUrl,
		});
		expect(status.message).toContain("Service health: ok");
		expect(status.message).toContain("tracks: dev, notes");
		expect(status.error).toBeUndefined();
		expect(requests[0]?.path).toBe("/healthz");
	});

	it("reports an inactive backend and the prefixed outage when healthz fails", async () => {
		respond = () => new Response("down", { status: 503 });
		const status = await memvidkbBackend.status!(context());
		expect(status.active).toBe(false);
		expect(status.error?.startsWith(KNOWLEDGE_ERROR_PREFIX.unreachable)).toBe(true);
	});

	it("reports a writable:false backend while central writes are off", async () => {
		await writeConfig({ remember: "off" });
		const status = await memvidkbBackend.status!(context());
		expect(status.writable).toBe(false);
		expect(status.searchable).toBe(true);
	});

	it("renders developer instructions from the resolved config, and nothing without one", async () => {
		const instructions = await memvidkbBackend.buildDeveloperInstructions!(
			temp.path(),
			temp.path(),
			Settings.isolated({}),
			undefined,
		);
		expect(instructions).toBeDefined();
		expect(instructions).toContain("fulton");
		expect(instructions).toContain("`dev`");
		// The resolver rejects any other shape (`internal-urls/knowledge-protocol.ts`
		// answers `invalid_knowledge_uri`), so the instructions must teach the two forms
		// that actually resolve — this line used to pin the malformed one.
		expect(instructions).toContain("knowledge://record/<context>/<track>/<record-id>");
		expect(instructions).toContain("knowledge://track/<context>/<track>");
		expect(instructions).not.toMatch(/knowledge:\/\/(?!record\/|track\/)/);
		expect(instructions).not.toContain(TOKEN);

		await writeConfig({ remember: "off" });
		const readOnly = await memvidkbBackend.buildDeveloperInstructions!(
			temp.path(),
			temp.path(),
			Settings.isolated({}),
			undefined,
		);
		expect(readOnly).toContain('remember to "off"');

		dropConfig();
		await expect(
			memvidkbBackend.buildDeveloperInstructions!(temp.path(), temp.path(), Settings.isolated({}), undefined),
		).resolves.toBeUndefined();
	});

	it("renders stats with the canonical lastVerifiedAt read off the wire", async () => {
		const stats = await memvidkbBackend.stats!(temp.path(), temp.path(), undefined);
		expect(stats).toContain("Memvid memory statistics");
		expect(stats).toContain("rec-42");
		expect(stats).toContain("2026-11-16T05:00:00Z");
		expect(requests[0]?.path).toBe("/memories/dev/records");
	});

	it("escapes pipes and collapses whitespace in every service-supplied stats cell", async () => {
		// The service owns these strings. Only the snippet used to be escaped, so one `|` in an
		// originActor re-shaped the row it sat in — and a newline would have split the table.
		respond = () =>
			Response.json({
				track: "dev",
				total: 1,
				limit: 5,
				offset: 0,
				results: [
					{
						id: "rec|42",
						uri: "mv2://dev/rec|42",
						title: null,
						tags: [],
						originActor: "operator|root\nsecond line",
						capturedAt: "2026-11-16T04:00:00Z",
						lastVerifiedAt: "2026-11-16T05:00:00Z",
						derivedFrom: null,
						supersededBy: null,
						textSnippet: "roll|restart",
					},
				],
			});
		const stats = await memvidkbBackend.stats!(temp.path(), temp.path(), undefined);
		if (typeof stats !== "string") throw new Error(`stats returned ${String(stats)} instead of a report`);
		const rows = stats.split("\n").filter(line => line.startsWith("| "));
		// Header, separator, and exactly one data row: nothing the service sent broke the table.
		expect(rows).toHaveLength(3);
		const row = rows[2] ?? "";
		expect(row).toContain("rec\\|42");
		expect(row).toContain("roll\\|restart");
		expect(row).toContain("operator\\|root second line");
	});

	it("names the bearer env var in diagnostics without ever naming its value", async () => {
		const diagnose = await memvidkbBackend.diagnose!(temp.path(), temp.path(), undefined);
		expect(diagnose).toContain(`bearer env: ${TOKEN_ENV}`);
		expect(diagnose).toContain("default track: dev");
		expect(diagnose).not.toContain(TOKEN);
	});

	it("keeps start, clear, and enqueue non-throwing even with no configuration at all", async () => {
		dropConfig();
		const session = { sessionManager: { getCwd: () => temp.path() } } as never;
		await expect(
			memvidkbBackend.start({
				session,
				settings: Settings.isolated({}),
				modelRegistry: undefined as never,
				agentDir: temp.path(),
				taskDepth: 0,
			}),
		).resolves.toBeUndefined();
		await expect(memvidkbBackend.clear(temp.path(), temp.path(), undefined)).resolves.toBeUndefined();
		await expect(memvidkbBackend.enqueue(temp.path(), temp.path(), undefined)).resolves.toBeUndefined();
	});
});
