/**
 * Hermetic tests for the native memvidkb client.
 *
 * The transport is stubbed in-process, never the client: every assertion below drives
 * real `fetch` traffic against a `Bun.serve` origin, so a wire change breaks a test here
 * rather than a mock. The stub pattern is copied from `test/hindsight-outbox.test.ts:35-64`
 * (`Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {...} })` with a
 * captured request log), and the port is always ephemeral — never a fixed one.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	findTrack,
	health,
	HEALTH_TIMEOUT_MS,
	HTTP_TIMEOUT_MS,
	listRecords,
	rememberRecord,
	type MemvidkbEndpoint,
} from "../src/memvidkb/client";
import { KNOWLEDGE_ERROR_PREFIX } from "../src/memvidkb/errors";

const TOKEN = "kb-test-bearer-7f3a";
/** The NAME of the variable holding `TOKEN`, so a refusal can name it the way an operator needs. */
const TOKEN_ENV = "MEMVIDKB_CLIENT_TEST_TOKEN";

type Recorded = {
	method: string;
	path: string;
	search: string;
	body: string;
	authorization: string | null;
	contentType: string | null;
	userAgent: string | null;
};

let server: Bun.Server<undefined>;
let baseUrl = "";
let closedPortBaseUrl = "";
let requests: Recorded[] = [];
let respond: ((request: Recorded) => Response | Promise<Response>) | undefined;

/** A `SearchResponse` as `src/search.rs:129-136` serializes it. */
function findBody(): unknown {
	return {
		query: "deploy runbook",
		limit: 10,
		offset: 0,
		total: 2,
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

/** A `RememberResponse` as `src/api/records/dto.rs:79-98` serializes it. */
function rememberBody(): unknown {
	return {
		id: "rec-42",
		uri: "mv2://dev/rec-42",
		frameId: "frame-42",
		track: "dev",
		title: "preference",
		tags: [],
		originActor: "j.patrickfulton",
		capturedAt: "2026-11-16T04:00:00Z",
		derivedFrom: null,
	};
}

/** A `RecordListResponse` as `src/api/records/dto.rs:175-186` serializes it. */
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
				title: null,
				tags: [],
				originActor: "j.patrickfulton",
				capturedAt: "2026-11-16T04:00:00Z",
				lastVerifiedAt: "2026-11-16T05:00:00Z",
				derivedFrom: null,
				supersededBy: null,
				textSnippet: "Roll the gateway first.",
			},
		],
	};
}

function defaultResponse(request: Recorded): Response {
	if (request.path === "/healthz")
		return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
	if (request.method === "POST" && request.path.endsWith("/find")) return Response.json(findBody());
	if (request.method === "POST" && request.path.endsWith("/records")) return Response.json(rememberBody());
	if (request.method === "GET" && request.path.endsWith("/records")) return Response.json(recordsBody());
	return new Response("not found", { status: 404 });
}

function endpoint(): MemvidkbEndpoint {
	return { baseUrl, tokenEnvVar: TOKEN_ENV, token: TOKEN };
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
				authorization: request.headers.get("authorization"),
				contentType: request.headers.get("content-type"),
				userAgent: request.headers.get("user-agent"),
			};
			requests.push(recorded);
			return respond ? respond(recorded) : defaultResponse(recorded);
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	// A port this process just released: connecting to it is refused, which is how the
	// transport-failure arm reaches `knowledge_unreachable:` without a fake.
	const transient = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
	closedPortBaseUrl = `http://127.0.0.1:${(transient as unknown as { port: number }).port}`;
	transient.stop(true);
});

afterEach(() => {
	respond = undefined;
	server.stop(true);
});

describe("memvidkb client find", () => {
	it("posts to the service's find route with the bearer and reads the typed page", async () => {
		const outcome = await findTrack(endpoint(), "dev", "deploy runbook");
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.data.total).toBe(2);
		expect(outcome.data.results[0]?.frameId).toBe("frame-1");
		expect(outcome.data.results[0]?.textSnippet).toBe("Roll the gateway before the router.");

		expect(requests).toHaveLength(1);
		const sent = requests[0];
		expect(sent?.method).toBe("POST");
		expect(sent?.path).toBe("/memories/dev/find");
		expect(sent?.authorization).toBe(`Bearer ${TOKEN}`);
		expect(sent?.contentType).toBe("application/json");
		expect(sent?.userAgent).toBe("omp-memvidkb-backend");
		expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ query: "deploy runbook" });
	});

	it("leaves unset options off the wire and sends the ones the caller chose", async () => {
		await findTrack(endpoint(), "dev", "q");
		const defaults = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect("mode" in defaults).toBe(false);
		expect("limit" in defaults).toBe(false);
		expect("offset" in defaults).toBe(false);

		await findTrack(endpoint(), "dev", "q", { limit: 3, mode: "hybrid" });
		const chosen = JSON.parse(requests[1]?.body ?? "{}") as Record<string, unknown>;
		expect(chosen).toMatchObject({ limit: 3, mode: "hybrid" });
	});

	it("encodes a track that needs it instead of letting it reshape the path", async () => {
		await findTrack(endpoint(), "team/ops", "q");
		expect(requests[0]?.path).toBe("/memories/team%2Fops/find");
	});

	it("refuses an undocumented mode and an empty query before anything reaches the wire", async () => {
		const badMode = await findTrack(endpoint(), "dev", "q", { mode: "magic" as "hybrid" });
		expect(badMode.ok).toBe(false);
		if (badMode.ok) return;
		expect(badMode.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(badMode.error).toContain("mode");

		const empty = await findTrack(endpoint(), "dev", "   ");
		expect(empty.ok).toBe(false);
		if (empty.ok) return;
		expect(empty.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(empty.error).toContain("nothing was sent");

		// Both refusals are pre-flight: the stub saw no request at all.
		expect(requests).toHaveLength(0);
	});

	it("refuses a blank bearer before the socket instead of sending `Bearer   `", async () => {
		// The `.memvidkb` readers accept this value at load (parity with the deployed reader),
		// so the transport is the last thing that can stop it. No request may be recorded.
		for (const blank of ["", "   ", "\t\n"]) {
			requests = [];
			const outcome = await findTrack({ baseUrl, tokenEnvVar: TOKEN_ENV, token: blank }, "dev", "q");
			expect(outcome.ok, `bearer ${JSON.stringify(blank)} must be refused`).toBe(false);
			if (outcome.ok) return;
			expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.invalidConfig)).toBe(true);
			expect(outcome.error).toContain(TOKEN_ENV);
			expect(outcome.error).toContain("TOKEN_ENV_UNSET");
			expect(requests).toHaveLength(0);
		}
	});

	it("sends the trimmed bearer, never the padded env value", async () => {
		// One env var, one wire value: the readers hand the padding down untouched, so the
		// header has to carry the trimmed credential the service will accept.
		const outcome = await findTrack({ baseUrl, tokenEnvVar: TOKEN_ENV, token: `  ${TOKEN}  ` }, "dev", "q");
		expect(outcome.ok).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
		expect(requests[0]?.authorization).not.toContain("  ");
	});

	it("reports a transport failure as an outage, never as zero results", async () => {
		const outcome = await findTrack({ baseUrl: closedPortBaseUrl, tokenEnvVar: TOKEN_ENV, token: TOKEN }, "dev", "q");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unreachable)).toBe(true);
		expect(outcome.error).toContain("retrieval outage, not a zero-result answer");
	});

	it("maps 429 and 5xx onto the outage prefix and 401/403/404 onto their own", async () => {
		// Outage arms report the bare status; the classified arms name the status and its
		// meaning, which is what makes a refusal distinguishable from an outage downstream.
		for (const [status, prefix, expected] of [
			[429, KNOWLEDGE_ERROR_PREFIX.unreachable, "HTTP 429"],
			[503, KNOWLEDGE_ERROR_PREFIX.unreachable, "HTTP 503"],
			[401, KNOWLEDGE_ERROR_PREFIX.unauthorized, "(401 unauthorized)"],
			[403, KNOWLEDGE_ERROR_PREFIX.forbidden, "(403 forbidden)"],
			[404, KNOWLEDGE_ERROR_PREFIX.notFound, "(404 not_found)"],
		] as const) {
			respond = () => new Response(JSON.stringify({ error: { code: "unavailable", message: "nope" } }), { status });
			const outcome = await findTrack(endpoint(), "dev", "q");
			expect(outcome.ok).toBe(false);
			if (outcome.ok) continue;
			expect(outcome.error.startsWith(prefix)).toBe(true);
			expect(outcome.error).toContain(expected);
			// Every arm keeps the service's own words, so a reader can act on them.
			expect(outcome.error).toContain("unavailable: nope");
		}
	});

	it("refuses a success body it cannot honour instead of reporting an empty page", async () => {
		respond = () => new Response("not json at all", { status: 200 });
		const notJson = await findTrack(endpoint(), "dev", "q");
		expect(notJson.ok).toBe(false);
		if (notJson.ok) return;
		expect(notJson.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(notJson.error).toContain("not JSON");
		expect(notJson.error).toContain("Refusing to report an unreadable success");

		respond = () => Response.json([]);
		const notObject = await findTrack(endpoint(), "dev", "q");
		expect(notObject.ok).toBe(false);
		if (notObject.ok) return;
		expect(notObject.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(notObject.error).toContain("not a JSON object");
	});

	it("names the first unreadable field when a documented field is absent", async () => {
		const partial = findBody() as { results?: unknown };
		delete partial.results;
		respond = () => Response.json(partial);
		const outcome = await findTrack(endpoint(), "dev", "q");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(outcome.error).toContain("results (expected an array of objects) was missing from the response");
	});

	it("scrubs the bearer out of an echoed service body", async () => {
		respond = () => new Response(`token was ${TOKEN}`, { status: 400 });
		const outcome = await findTrack(endpoint(), "dev", "q");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).not.toContain(TOKEN);
		expect(outcome.error).toContain("[redacted]");
	});

	it("scrubs the padded bearer out of an echoed service body", async () => {
		// `redactToken` splits on the literal it is handed, so scrubbing has to use the value
		// that actually went out: fed the raw padded env value instead, the echo below would
		// survive redaction and carry the bearer into model-visible refusal text.
		respond = () => new Response(`rejected ${TOKEN}`, { status: 400 });
		const outcome = await findTrack({ baseUrl, tokenEnvVar: TOKEN_ENV, token: `  ${TOKEN}  ` }, "dev", "q");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).not.toContain(TOKEN);
		expect(outcome.error).toContain("[redacted]");
	});

	it("scrubs the padded bearer out of a non-JSON success body", async () => {
		// The other scrub site: an unreadable 2xx body is clipped, not envelope-rendered, so
		// this arm pins that path too — same padded env value, same echo of the sent value.
		respond = () => new Response(`unreadable body carried ${TOKEN}`, { status: 200 });
		const outcome = await findTrack({ baseUrl, tokenEnvVar: TOKEN_ENV, token: `  ${TOKEN}  ` }, "dev", "q");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("not JSON");
		expect(outcome.error).not.toContain(TOKEN);
		expect(outcome.error).toContain("[redacted]");
	});
});

describe("memvidkb client records", () => {
	it("sends the canonical request spellings the remember route deserializes", async () => {
		const outcome = await rememberRecord(endpoint(), {
			track: "dev",
			content: "Roll the gateway before the router.",
			originActor: "j.patrickfulton",
			title: "preference",
			tags: [" runbook ", "", "deploy"],
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.data.id).toBe("rec-42");
		expect(outcome.data.capturedAt).toBe("2026-11-16T04:00:00Z");

		const sent = requests[0];
		expect(sent?.method).toBe("POST");
		expect(sent?.path).toBe("/memories/dev/records");
		const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["content", "originActor", "tags", "title"]);
		expect(body["originActor"]).toBe("j.patrickfulton");
		// Blank tags are trimmed away rather than tagged onto the record.
		expect(body["tags"]).toEqual(["runbook", "deploy"]);
	});

	it("refuses a write with no producing actor before sending it", async () => {
		const outcome = await rememberRecord(endpoint(), { track: "dev", content: "x", originActor: "  " });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(outcome.error).toContain("originActor was empty");
		expect(requests).toHaveLength(0);
	});

	// The provider grant is enforced at this boundary — the one place a write crosses — so
	// an endpoint assembled by hand exercises it with no config loader in the way. `requests`
	// is filled by the stub server's fetch handler, so an empty list is proof no socket
	// opened: a message-substring match alone would also be satisfied by an outage.
	it("refuses a provider the endpoint's grant does not admit, before opening a socket", async () => {
		const outcome = await rememberRecord(
			{ ...endpoint(), context: "fulton", providers: ["litellm"] },
			{ track: "dev", content: "x", originActor: "user", provider: "openrouter" },
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.forbidden)).toBe(true);
		expect(outcome.error).toContain('provider "openrouter"');
		expect(outcome.error).toContain('context "fulton"');
		expect(outcome.error).toContain('.memvidkb "providers"');
		expect(outcome.error).toContain("litellm");
		expect(requests).toHaveLength(0);
	});

	it("sends an admitted provider as the record's producer", async () => {
		const outcome = await rememberRecord(
			{ ...endpoint(), context: "fulton", providers: ["litellm"] },
			{ track: "dev", content: "x", originActor: "user", provider: "litellm" },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["content", "originActor", "provider"]);
		expect(body["provider"]).toBe("litellm");
	});

	it("sends any provider when the grant is empty, which is no rule at all", async () => {
		const outcome = await rememberRecord(
			{ ...endpoint(), context: "fulton", providers: [] },
			{ track: "dev", content: "x", originActor: "user", provider: "openrouter" },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(requests).toHaveLength(1);
		const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(body["provider"]).toBe("openrouter");
	});

	it("says plainly that an unreachable write stored nothing", async () => {
		const outcome = await rememberRecord(
			{ baseUrl: closedPortBaseUrl, tokenEnvVar: TOKEN_ENV, token: TOKEN },
			{ track: "dev", content: "x", originActor: "user" },
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unreachable)).toBe(true);
		expect(outcome.error).toContain("Nothing was stored, queued, or retried locally");
	});

	it("reads the canonical lastVerifiedAt spelling out of a record listing", async () => {
		const outcome = await listRecords(endpoint(), { track: "dev", limit: 5, offset: 10 });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.data.records[0]?.lastVerifiedAt).toBe("2026-11-16T05:00:00Z");
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.path).toBe("/memories/dev/records");
		// Paging travels as the documented query parameters, and only when supplied.
		expect(requests[0]?.search).toBe("?limit=5&offset=10");

		await listRecords(endpoint(), { track: "dev" });
		expect(requests[1]?.search).toBe("");
	});
});

describe("memvidkb client health", () => {
	it("accepts the plain-text body healthz answers with", async () => {
		const outcome = await health(endpoint());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.data).toEqual({ reachable: true, body: "ok" });
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.path).toBe("/healthz");
	});

	it("refuses an empty health body rather than calling it healthy", async () => {
		respond = () => new Response("", { status: 200 });
		const outcome = await health(endpoint());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unavailable)).toBe(true);
		expect(outcome.error).toContain("Refusing to report an empty success");
	});

	it("reports an unreachable service through the outage prefix", async () => {
		const outcome = await health({ baseUrl: closedPortBaseUrl, tokenEnvVar: TOKEN_ENV, token: TOKEN });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unreachable)).toBe(true);
	});

	it("gives the liveness probe a budget shorter than an ordinary call", () => {
		// `/memory status` and the settings UI render straight off this answer, so it must not
		// inherit the full call timeout. Red if the probe ever reverts to HTTP_TIMEOUT_MS.
		expect(HEALTH_TIMEOUT_MS).toBeLessThan(HTTP_TIMEOUT_MS);
		expect(HEALTH_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
	});

	it("probes on the short budget by default, without the caller naming one", async () => {
		// `status()` and `diagnose()` rely on this default, and proving it by waiting out the
		// five-second budget would tax every run. The timer factory is the wiring, so spy it:
		// deterministic, and red if the default parameter is ever swapped for the long budget.
		const real = AbortSignal.timeout;
		const budgets: number[] = [];
		AbortSignal.timeout = (ms: number): AbortSignal => {
			budgets.push(ms);
			return real.call(AbortSignal, ms);
		};
		try {
			const probe = await health(endpoint());
			expect(probe.ok).toBe(true);
			const found = await findTrack(endpoint(), "dev", "q");
			expect(found.ok).toBe(true);
		} finally {
			AbortSignal.timeout = real;
		}
		expect(budgets[0]).toBe(HEALTH_TIMEOUT_MS);
		expect(budgets[1]).toBe(HTTP_TIMEOUT_MS);
	});

	it("reports a wedged service as unreachable once the probe budget expires", async () => {
		// Deliberately a real-clock arm: the behaviour under test IS the platform abort timer
		// (`AbortSignal.timeout` inside `withTimeoutSignal`), so fake timers would stub out the
		// thing being proven. The stub never answers on its own — the client's own budget is the
		// only thing that ends the call, so the test itself adds no guessed wait.
		const wedged = Promise.withResolvers<void>();
		respond = async () => {
			await wedged.promise;
			return new Response("ok");
		};
		const started = performance.now();
		try {
			const outcome = await health(endpoint(), undefined, 25);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.unreachable)).toBe(true);
		} finally {
			wedged.resolve();
		}
		// A ceiling, not a wait: red if the probe ever silently reverts to the 15s call budget.
		expect(performance.now() - started).toBeLessThan(2_000);
		respond = undefined;
		// The budget is per-call, not global: the recall path keeps its ordinary timeout and
		// this same origin still answers it.
		const found = await findTrack(endpoint(), "dev", "q");
		expect(found.ok).toBe(true);
	});
});
