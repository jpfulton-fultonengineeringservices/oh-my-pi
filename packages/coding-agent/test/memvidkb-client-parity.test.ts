/**
 * Wire-contract parity between this package's native client and the deployed contract.
 *
 * Authority for everything in the tables below is the eleven-verb surface already merged in
 * the config repo:
 *   - `extensions/lib/knowledge/client.ts:121-140` — the status -> failure-prefix map
 *     (401 unauthorized, 403 forbidden, 404 not_found, 400 validation, 409 file_locked,
 *     429 and 5xx unreachable);
 *   - `extensions/lib/knowledge/errors.ts` — `ERROR_PREFIX`, whose values the
 *     `KNOWLEDGE_ERROR_PREFIX` table mirrors;
 *   - `extensions/lib/knowledge/dto.ts` — canonical response field spellings, notably
 *     `lastVerifiedAt`, which the service serializes in camelCase.
 *
 * Why this is a frozen table and not an import: config-repo extensions are compiled against
 * the *published* `@oh-my-pi/pi-coding-agent`, which contains none of these fork modules, and
 * this package cannot resolve a path into the config repo — the asymmetry its own
 * `extensions/lib/knowledge/config.ts:1-38` records as the reason each side carries its own
 * thin client. A same-repo read-back is therefore impossible, so both clients are pinned to
 * this table instead: drift on either side has to break an arm here.
 *
 * The transport stub is the house pattern, copied from `test/hindsight-outbox.test.ts:35-64`
 * (`Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { ... } })` with a
 * captured request log). Ports are always ephemeral — never a fixed one — and nothing here
 * reaches a real service.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as clientModule from "../src/memvidkb/client";
import { findTrack, health, listRecords, rememberRecord, type MemvidkbEndpoint } from "../src/memvidkb/client";
import { KNOWLEDGE_ERROR_PREFIX } from "../src/memvidkb/errors";

const TOKEN = "kb-parity-bearer-9c14";

type Recorded = { method: string; path: string; search: string; body: string };

let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];
let respond: ((request: Recorded) => Response) | undefined;

/**
 * Routes the service registers (`src/api.rs:139-177`) and the verbs the merged config-repo
 * client calls. `{track}` is substituted at call time.
 */
const ROUTES = [
	{ verb: "find", method: "POST", path: "/memories/dev/find", call: () => findTrack(endpoint(), "dev", "q") },
	{
		verb: "list",
		method: "GET",
		path: "/memories/dev/records",
		call: () => listRecords(endpoint(), { track: "dev" }),
	},
	{
		verb: "remember",
		method: "POST",
		path: "/memories/dev/records",
		call: () => rememberRecord(endpoint(), { track: "dev", content: "c", originActor: "operator" }),
	},
	{ verb: "health", method: "GET", path: "/healthz", call: () => health(endpoint()) },
] as const;

/** Status -> taxonomy, transcribed from the deployed `statusFailure` cited in the header. */
const STATUS_TAXONOMY = [
	{ status: 401, prefix: KNOWLEDGE_ERROR_PREFIX.unauthorized, label: "401 unauthorized" },
	{ status: 403, prefix: KNOWLEDGE_ERROR_PREFIX.forbidden, label: "403 forbidden" },
	{ status: 404, prefix: KNOWLEDGE_ERROR_PREFIX.notFound, label: "404 not_found" },
	{ status: 400, prefix: KNOWLEDGE_ERROR_PREFIX.unavailable, label: "400 validation" },
	{ status: 409, prefix: KNOWLEDGE_ERROR_PREFIX.unavailable, label: "409 file_locked" },
	{ status: 429, prefix: KNOWLEDGE_ERROR_PREFIX.unreachable, label: "HTTP 429" },
	{ status: 503, prefix: KNOWLEDGE_ERROR_PREFIX.unreachable, label: "HTTP 503" },
] as const;

/** Canonical spellings `src/api/records/dto.rs:175-186` uses for a listed record. */
const RECORD_FIELDS = [
	"id",
	"uri",
	"title",
	"tags",
	"originActor",
	"capturedAt",
	"lastVerifiedAt",
	"derivedFrom",
	"supersededBy",
	"textSnippet",
] as const;

/** Canonical spellings `src/search.rs:129-136` uses for a hit. */
const FRAME_FIELDS = ["frameId", "documentId", "uri", "score", "textSnippet", "title", "timestamp"] as const;

/** A `RememberResponse` as `src/api/records/dto.rs:79-98` serializes it. */
function rememberBody(): unknown {
	return {
		id: "rec-42",
		uri: "mv2://dev/rec-42",
		frameId: "frame-42",
		track: "dev",
		title: "preference",
		tags: ["runbook"],
		originActor: "operator",
		capturedAt: "2026-11-16T04:00:00Z",
		derivedFrom: null,
	};
}

function recordsBody(): unknown {
	return {
		track: "dev",
		total: 1,
		limit: 5,
		offset: 0,
		results: [
			{
				id: "rec-42",
				uri: "mv2://dev/rec-42",
				title: "preference",
				tags: ["runbook"],
				originActor: "operator",
				capturedAt: "2026-11-16T04:00:00Z",
				lastVerifiedAt: "2026-11-16T05:00:00Z",
				derivedFrom: null,
				supersededBy: null,
				textSnippet: "Roll the gateway first.",
			},
		],
	};
}

function findBody(): unknown {
	return {
		query: "q",
		limit: 10,
		offset: 0,
		total: 1,
		mode: "lexical",
		results: [
			{
				frameId: "frame-1",
				documentId: "mv2://dev/deploy.md",
				uri: "mv2://dev/deploy.md#chunk-0",
				score: 0.87,
				textSnippet: "Roll the gateway before the router.",
				title: "Deploy",
				timestamp: 1_763_000_000,
			},
		],
	};
}

function endpoint(): MemvidkbEndpoint {
	return { baseUrl, tokenEnvVar: "MEMVIDKB_PARITY_TEST_TOKEN", token: TOKEN };
}

beforeEach(async () => {
	requests = [];
	respond = undefined;
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
			requests.push(recorded);
			if (respond) return respond(recorded);
			if (recorded.path === "/healthz")
				return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
			if (recorded.method === "POST" && recorded.path.endsWith("/find")) return Response.json(findBody());
			if (recorded.method === "POST") return Response.json(rememberBody());
			return Response.json(recordsBody());
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
});

afterEach(() => {
	respond = undefined;
	server.stop(true);
});

describe("memvidkb client wire-contract parity", () => {
	it("calls exactly the routes the service registers, with the methods it registers", async () => {
		for (const route of ROUTES) {
			requests = [];
			const outcome = await route.call();
			expect(outcome.ok, `${route.verb} should succeed against the stub`).toBe(true);
			expect(requests, `${route.verb} should make exactly one request`).toHaveLength(1);
			expect(requests[0]?.method, `${route.verb} method`).toBe(route.method);
			expect(requests[0]?.path, `${route.verb} path`).toBe(route.path);
		}
	});

	it("speaks no verb the service does not register", () => {
		// The service documents no delete, erase, vacuum, compaction, or discover route
		// (`src/api.rs:139-177`), so a client that grew one would be inventing an endpoint.
		// The pattern names the shapes a new verb would take, so growing one — `deleteRecord`,
		// `eraseTrack` — lands here rather than on the wire.
		const functions = Object.entries(clientModule).filter(([, value]) => typeof value === "function");
		const wireVerbs = functions
			.map(([name]) => name)
			.filter(name => /(Track|Record|health|discover|erase|delete|vacuum|compact)/.test(name));
		expect(wireVerbs.sort()).toEqual(["findTrack", "health", "listRecords", "rememberRecord"]);
	});

	it("reads the canonical field spellings the service serializes", async () => {
		const found = await findTrack(endpoint(), "dev", "q");
		expect(found.ok).toBe(true);
		if (!found.ok) return;
		const frame = found.data.results[0];
		expect(frame).toBeDefined();
		for (const field of FRAME_FIELDS) {
			expect(field in (frame ?? {}), `frame exposes canonical ${field}`).toBe(true);
		}

		const listed = await listRecords(endpoint(), { track: "dev" });
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		const record = listed.data.records[0];
		expect(record).toBeDefined();
		for (const field of RECORD_FIELDS) {
			expect(field in (record ?? {}), `record exposes canonical ${field}`).toBe(true);
		}
		// The one spelling both sides had to align on by hand.
		expect(record?.lastVerifiedAt).toBe("2026-11-16T05:00:00Z");
	});

	it("refuses to read a snake_case body as canonical fields", async () => {
		// Only the aliases are present: the canonical twins are absent, so anything the client
		// reports here could only have come from a spelling it was never given.
		respond = () =>
			Response.json({
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
						last_verified_at: "2026-11-16T05:00:00Z",
						captured_at: "2026-11-16T04:00:00Z",
						origin_actor: "operator",
						text_snippet: "Roll the gateway first.",
					},
				],
			});
		const listed = await listRecords(endpoint(), { track: "dev" });
		// Either the parse is rejected outright or the aliases are ignored — never adopted.
		if (listed.ok) {
			expect(listed.data.records[0]?.lastVerifiedAt).toBeUndefined();
			expect(JSON.stringify(listed.data)).not.toContain("Roll the gateway first.");
		} else {
			expect(listed.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		}
	});

	it("sends the canonical field spellings when writing a record", async () => {
		const stored = await rememberRecord(endpoint(), {
			track: "dev",
			content: "Roll gateway before router.",
			originActor: "operator",
			title: "preference",
			tags: ["runbook"],
		});
		expect(stored.ok).toBe(true);
		const sent = requests[0];
		expect(sent?.method).toBe("POST");
		expect(sent?.path).toBe("/memories/dev/records");
		const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["content", "originActor", "tags", "title"]);
	});

	it("maps every documented status onto the shared failure taxonomy", async () => {
		for (const arm of STATUS_TAXONOMY) {
			respond = () => new Response(`service said no: ${String(arm.status)}`, { status: arm.status });
			const outcome = await findTrack(endpoint(), "dev", "q");
			expect(outcome.ok, `HTTP ${String(arm.status)} must fail`).toBe(false);
			if (outcome.ok) return;
			expect(outcome.error.startsWith(arm.prefix), `HTTP ${String(arm.status)} prefix`).toBe(true);
			// The status the operator has to act on is named, in the deployed client's vocabulary.
			expect(outcome.error).toContain(arm.label);
		}
	});

	it("keeps the bearer out of every failure message it returns", async () => {
		respond = () => new Response(`token ${TOKEN} rejected`, { status: 401 });
		const outcome = await findTrack(endpoint(), "dev", "q");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).not.toContain(TOKEN);
	});
});
