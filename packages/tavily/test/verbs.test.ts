/**
 * The verbs, end to end.
 *
 * Half of this file drives real HTTP through `@tavily/core`'s axios transport,
 * because that is where a misnamed wire key or an unread error body actually
 * shows up. The other half records transport calls directly, which is the only
 * practical way to see an endpoint name, a per-verb timeout budget, or the fact
 * that a keyless client never built a request at all.
 */

import { describe, expect, it } from "bun:test";
import {
	createTavilyClient,
	tavilyCrawl,
	tavilyExtract,
	tavilyMap,
	tavilyResearch,
	tavilyResearchStatus,
	tavilySearch,
} from "../src/index";
import type { TavilyClient, TavilyResult } from "../src/index";
import { hold, json, startMockTavilyServer, type MockHandler, type MockTavilyServer } from "./helpers/mock-server";
import { stubClient } from "./helpers/mock-transport";
import { KEYLESS_ENV, withEnv } from "./helpers/env";

async function withServer<T>(handler: MockHandler, run: (server: MockTavilyServer) => Promise<T>): Promise<T> {
	const server = await startMockTavilyServer(handler);
	try {
		return await run(server);
	} finally {
		await server.close();
	}
}

function keyedClient(baseUrl: string, timeoutSeconds?: number) {
	const client = createTavilyClient({ apiBaseURL: baseUrl, apiKey: "sk-test" });
	return { client, timeoutSeconds };
}

/** Unwrap a verb result, failing the test with the failure when it is not ok. */
function unwrap<T>(result: TavilyResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.data;
}

describe("tavilySearch over HTTP", () => {
	it("posts snake_case to /search and hands back a normalised result", async () => {
		await withServer(
			() =>
				json({
					query: "hello",
					answer: "hi",
					results: [{ title: "A", url: "https://a", content: "c", images: ["https://i/1.png"], score: 0.9 }],
					response_time: 0.4,
					request_id: "req-1",
					usage: { credits: 1 },
				}),
			async server => {
				const { client } = keyedClient(server.baseUrl);
				const data = unwrap(
					await tavilySearch(client, {
						query: "hello",
						searchDepth: "advanced",
						maxResults: 3,
						includeAnswer: true,
						includeUsage: true,
					}),
				);

				const request = server.lastRequest();
				expect(request?.method).toBe("POST");
				expect(request?.path).toBe("/search");
				expect(request?.body).toEqual({
					query: "hello",
					search_depth: "advanced",
					max_results: 3,
					include_answer: true,
					include_usage: true,
				});

				expect(data.query).toBe("hello");
				expect(data.answer).toBe("hi");
				expect(data.responseTime).toBe(0.4);
				expect(data.requestId).toBe("req-1");
				expect(data.usage).toEqual({ credits: 1 });
				expect(data.results[0]?.images).toEqual([{ url: "https://i/1.png" }]);
			},
		);
	});

	it("maps a 429 to a rate-limit failure that keeps the status", async () => {
		await withServer(
			() => json({ error: "slow down" }, 429),
			async server => {
				const result = await tavilySearch(keyedClient(server.baseUrl).client, { query: "hello" });
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("rate-limit");
				expect(result.error.status).toBe(429);
				expect(result.error.detail).toContain("slow down");
			},
		);
	});

	it("maps a keyless-limit envelope to keyless-limit, not to a generic error", async () => {
		const envelope = {
			error: {
				code: "hourly_keyless_limit",
				message: "You have hit the hourly keyless limit",
				next_actions: [{ type: "bonus_credits", params: { credits_on_completion: 5 } }],
			},
		};
		await withServer(
			() => json(envelope, 403),
			async server => {
				const result = await tavilySearch(keyedClient(server.baseUrl).client, { query: "hello" });
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("keyless-limit");
				expect(result.error.status).toBe(403);
				expect(result.error.message).toBe("You have hit the hourly keyless limit");
				expect(result.error.detail).toContain("cap=hourly_keyless_limit");
			},
		);
	});

	it("maps a 400 to bad-request and a 500 to transport", async () => {
		await withServer(
			() => json({ detail: { error: "query required" } }, 400),
			async server => {
				const result = await tavilySearch(keyedClient(server.baseUrl).client, { query: "" });
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("bad-request");
				expect(result.error.status).toBe(400);
				expect(result.error.detail).toContain("query required");
			},
		);
		await withServer(
			() => json({ error: "boom" }, 500),
			async server => {
				const result = await tavilySearch(keyedClient(server.baseUrl).client, { query: "hello" });
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("transport");
				expect(result.error.status).toBe(500);
			},
		);
	});

	it("surfaces a non-JSON error body as detail", async () => {
		await withServer(
			() => ({ status: 502, text: "<html>bad gateway</html>", contentType: "text/html" }),
			async server => {
				const result = await tavilySearch(keyedClient(server.baseUrl).client, { query: "hello" });
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("transport");
				expect(result.error.status).toBe(502);
				expect(result.error.detail).toContain("bad gateway");
			},
		);
	});

	it("reports a timeout when the budget runs out", async () => {
		// A genuine clock: the timeout under test is axios' socket timer, which a
		// fake clock would never fire. The budget is 50ms, so the cost is one tick.
		await withServer(
			() => hold(),
			async server => {
				const result = await tavilySearch(keyedClient(server.baseUrl).client, {
					query: "hello",
					timeoutSeconds: 0.05,
				});
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("timeout");
				expect(server.requests).toHaveLength(1);
			},
		);
	});

	it("resolves an already-aborted signal without touching the network", async () => {
		await withServer(
			() => json({ results: [] }),
			async server => {
				const controller = new AbortController();
				controller.abort();
				const result = await tavilySearch(keyedClient(server.baseUrl).client, {
					query: "hello",
					signal: controller.signal,
				});
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("aborted");
				expect(server.requests).toHaveLength(0);
			},
		);
	});

	it("resolves an abort that lands mid-request instead of hanging", async () => {
		await withServer(
			() => hold(),
			async server => {
				const controller = new AbortController();
				const inFlight = tavilySearch(keyedClient(server.baseUrl).client, {
					query: "hello",
					signal: controller.signal,
				});
				// Abort at the moment the request is really on the wire, not after a guess.
				await server.waitForRequest(1);
				controller.abort();
				const result = await inFlight;
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.error.code).toBe("aborted");
				expect(result.error.message.length).toBeGreaterThan(0);
			},
		);
	});
});

describe("endpoints and budgets", () => {
	it("names one endpoint per verb", async () => {
		const search = stubClient();
		await tavilySearch(search.client, { query: "x" });
		expect(search.last()).toMatchObject({ kind: "post", endpoint: "search" });

		const extract = stubClient();
		await tavilyExtract(extract.client, { urls: ["https://a"] });
		expect(extract.last()).toMatchObject({ kind: "post", endpoint: "extract" });

		const crawl = stubClient();
		await tavilyCrawl(crawl.client, { url: "https://a" });
		expect(crawl.last()).toMatchObject({ kind: "post", endpoint: "crawl" });

		const map = stubClient();
		await tavilyMap(map.client, { url: "https://a" });
		expect(map.last()).toMatchObject({ kind: "post", endpoint: "map" });

		const research = stubClient();
		await tavilyResearch(research.client, { input: "why" });
		expect(research.last()).toMatchObject({ kind: "post", endpoint: "research" });

		const status = stubClient();
		await tavilyResearchStatus(status.client, { requestId: "req 1/2" });
		expect(status.last()).toMatchObject({ kind: "get", endpoint: "research/req%201%2F2" });
	});

	it("applies the documented per-verb timeout budget, and honours an override", async () => {
		const expectations: ReadonlyArray<readonly [string, number | undefined]> = [
			["search", 60],
			["extract", 30],
			["crawl", 150],
			["map", 150],
			["research", undefined],
			["researchStatus", 60],
		];

		const search = stubClient();
		await tavilySearch(search.client, { query: "x" });
		const extract = stubClient();
		await tavilyExtract(extract.client, { urls: ["https://a"] });
		const crawl = stubClient();
		await tavilyCrawl(crawl.client, { url: "https://a" });
		const map = stubClient();
		await tavilyMap(map.client, { url: "https://a" });
		const research = stubClient();
		await tavilyResearch(research.client, { input: "why" });
		const status = stubClient();
		await tavilyResearchStatus(status.client, { requestId: "r" });

		const seen = [
			search.last()?.opts?.timeoutSeconds,
			extract.last()?.opts?.timeoutSeconds,
			crawl.last()?.opts?.timeoutSeconds,
			map.last()?.opts?.timeoutSeconds,
			research.last()?.opts?.timeoutSeconds,
			status.last()?.opts?.timeoutSeconds,
		];
		expect(seen).toEqual(expectations.map(([, budget]) => budget));

		const overridden = stubClient();
		await tavilySearch(overridden.client, { query: "x", timeoutSeconds: 5 });
		expect(overridden.last()?.opts?.timeoutSeconds).toBe(5);

		// `timeout` is the name the tool table advertises for the research budget;
		// advertising it without honouring it would be a silent drop.
		const budgeted = stubClient();
		await tavilyResearch(budgeted.client, { input: "why", timeout: 5 });
		expect(budgeted.last()?.opts?.timeoutSeconds).toBe(5);

		const bothNames = stubClient();
		await tavilyResearch(bothNames.client, { input: "why", timeout: 5, timeoutSeconds: 9 });
		expect(bothNames.last()?.opts?.timeoutSeconds).toBe(9);
	});

	it("sends the research status include_usage as a query parameter, not a body", async () => {
		const status = stubClient({ replies: { "research/r1": { request_id: "r1", status: "complete" } } });
		const data = unwrap(await tavilyResearchStatus(status.client, { requestId: "r1", includeUsage: true }));
		expect(status.last()?.params).toEqual({ include_usage: true });
		expect(status.last()?.body).toBeUndefined();
		expect(data).toEqual({ requestId: "r1", status: "complete" });
	});

	it("keeps a research submission unstreamed", async () => {
		const research = stubClient({ replies: { research: { request_id: "r9", status: "in_progress" } } });
		const data = unwrap(await tavilyResearch(research.client, { input: "why", model: "mini" }));
		expect(research.last()?.body).toEqual({ input: "why", model: "mini" });
		expect(data).toEqual({ requestId: "r9", status: "in_progress" });
	});

	it("passes each verb's curated fields through to the body", async () => {
		const extract = stubClient();
		await tavilyExtract(extract.client, {
			urls: ["https://a"],
			extractDepth: "advanced",
			query: "x",
			chunksPerSource: 3,
		});
		expect(extract.last()?.body).toEqual({
			urls: ["https://a"],
			extract_depth: "advanced",
			query: "x",
			chunks_per_source: 3,
		});

		const crawl = stubClient();
		await tavilyCrawl(crawl.client, { url: "https://a", maxDepth: 2, selectPaths: ["/docs"], allowExternal: true });
		expect(crawl.last()?.body).toEqual({
			url: "https://a",
			max_depth: 2,
			select_paths: ["/docs"],
			allow_external: true,
		});

		const map = stubClient();
		await tavilyMap(map.client, { url: "https://a", limit: 20, excludeDomains: ["x.com"] });
		expect(map.last()?.body).toEqual({ url: "https://a", limit: 20, exclude_domains: ["x.com"] });
	});
});

describe("the keyless gate", () => {
	const gated: ReadonlyArray<readonly [string, (client: TavilyClient) => Promise<TavilyResult<unknown>>]> = [
		["crawl", client => tavilyCrawl(client, { url: "https://a" })],
		["map", client => tavilyMap(client, { url: "https://a" })],
		["research", client => tavilyResearch(client, { input: "why" })],
		["research_status", client => tavilyResearchStatus(client, { requestId: "r1" })],
	];

	for (const [name, call] of gated) {
		it(`refuses ${name} without an API key and builds no request`, async () => {
			const stub = stubClient({ hasApiKey: false, apiKey: undefined });
			const result = await call(stub.client);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.code).toBe("auth");
			expect(result.error.message).toContain("Keyless mode only supports search and extract");
			expect(result.error.message).toContain(name === "research_status" ? "getResearch" : name);
			expect(stub.calls).toHaveLength(0);
		});
	}

	it("refuses the gated verbs over real HTTP without sending anything", async () => {
		await withServer(
			() => json({}),
			async server => {
				await withEnv(KEYLESS_ENV, async () => {
					const client = createTavilyClient({ apiBaseURL: server.baseUrl });
					expect(client.hasApiKey).toBe(false);
					const crawl = await tavilyCrawl(client, { url: "https://a" });
					const map = await tavilyMap(client, { url: "https://a" });
					expect(crawl.ok).toBe(false);
					expect(map.ok).toBe(false);
				});
				expect(server.requests).toHaveLength(0);
			},
		);
	});

	it("lets search and extract through keyless, as the API allows", async () => {
		await withServer(
			() => json({ results: [] }),
			async server => {
				await withEnv(KEYLESS_ENV, async () => {
					const client = createTavilyClient({ apiBaseURL: server.baseUrl });
					expect((await tavilySearch(client, { query: "hello" })).ok).toBe(true);
					expect((await tavilyExtract(client, { urls: ["https://a"] })).ok).toBe(true);
				});
				expect(server.requests).toHaveLength(2);
				expect(server.lastRequest()?.headers["x-tavily-access-mode"]).toBe("keyless");
			},
		);
	});
});

describe("tavilyExtract / tavilyCrawl / tavilyMap over HTTP", () => {
	it("normalises extract results and failed results", async () => {
		await withServer(
			() =>
				json({
					results: [{ url: "https://a", raw_content: "# A", images: [] }],
					failed_results: [{ url: "https://b", error: "403" }],
					base_url: "https://a",
				}),
			async server => {
				const data = unwrap(await tavilyExtract(keyedClient(server.baseUrl).client, { urls: ["https://a"] }));
				expect(data.results[0]?.rawContent).toBe("# A");
				expect(data.failedResults).toEqual([{ url: "https://b", error: "403" }]);
				expect(data.baseUrl).toBe("https://a");
				expect(server.lastRequest()?.path).toBe("/extract");
			},
		);
	});

	it("normalises a crawl body", async () => {
		await withServer(
			() => json({ results: [{ url: "https://a", title: "A", raw_content: "body" }], response_time: 2 }),
			async server => {
				const data = unwrap(
					await tavilyCrawl(keyedClient(server.baseUrl).client, { url: "https://a", maxDepth: 1 }),
				);
				expect(data.results[0]).toEqual({ url: "https://a", title: "A", rawContent: "body" });
				expect(data.responseTime).toBe(2);
				expect(server.lastRequest()?.path).toBe("/crawl");
			},
		);
	});

	it("normalises a map body whose results are bare URLs", async () => {
		await withServer(
			() => json({ results: ["https://a", "https://b"] }),
			async server => {
				const data = unwrap(await tavilyMap(keyedClient(server.baseUrl).client, { url: "https://a" }));
				expect(data.results).toEqual([{ url: "https://a" }, { url: "https://b" }]);
				expect(server.lastRequest()?.path).toBe("/map");
			},
		);
	});
});
