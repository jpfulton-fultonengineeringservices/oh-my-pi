import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	buildRequestBody,
	searchTavily,
	type TavilySearchParams,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/tavily";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const catalogAuthStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(catalogAuthStorage);

function requireTavilyModel() {
	const model = modelRegistry.find("web", "tavily");
	if (!model) throw new Error("Expected bundled web/tavily model");
	return model;
}

const tavilyModel = requireTavilyModel();

afterAll(() => {
	catalogAuthStorage.close();
});

describe("Tavily buildRequestBody", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits topic entirely so Tavily uses its default general index", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes" });
		expect(body).not.toHaveProperty("topic");
	});

	it("does not send time_range when recency is unset", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes" });
		expect(body).not.toHaveProperty("time_range");
	});

	it("always includes query, max_results, search_depth, and include_answer", () => {
		const body = buildRequestBody({ query: "q", num_results: 7 });
		expect(body.query).toBe("q");
		expect(body.max_results).toBe(7);
		expect(body.search_depth).toBe("basic");
		expect(body.include_answer).toBe("advanced");
		expect(body.include_raw_content).toBe(false);
	});

	it("prefers explicit start_date/end_date over time_range", () => {
		const body = buildRequestBody({ query: "q", recency: "week", start_date: "2026-01-01", end_date: "2026-02-01" });
		expect(body.start_date).toBe("2026-01-01");
		expect(body.end_date).toBe("2026-02-01");
		expect(body).not.toHaveProperty("time_range");
	});
});

describe("Tavily searchTavily request shape (integration)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
	});

	const fakeAuthStorage = {
		keys: {
			get: async () => process.env.TAVILY_API_KEY ?? undefined,
			resolver: vi.fn(() => async () => process.env.TAVILY_API_KEY ?? undefined),
			source: () => (process.env.TAVILY_API_KEY ? { kind: "env", concrete: true } : undefined),
		},
	} as unknown as AuthStorage;

	function makeParams(query: string, extras: Partial<TavilySearchParams> = {}) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Tavily integration test prompt",
			...extras,
			model: tavilyModel,
			modelRegistry,
		};
	}

	it("does not send topic=news to the upstream API when recency is set", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						answer: "test answer",
						results: [
							{
								title: "Bun v1.3.12",
								url: "https://bun.com/blog/bun-v1.3.12",
								content: "release notes",
								published_date: "2026-04-09",
							},
						],
						request_id: "req-123",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		};

		const response = await searchTavily({
			...makeParams("Bun runtime latest release notes", { recency: "week" }),
			fetch: fetchMock,
		});

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("topic");
		expect(capturedBody?.time_range).toBe("week");
		expect(capturedBody?.query).toBe("Bun runtime latest release notes");

		expect(response.provider).toBe("tavily");
		expect(response.answer).toBe("test answer");
		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.url).toBe("https://bun.com/blog/bun-v1.3.12");
	});

	it("maps site: directives to include/exclude_domains and strips them from the query", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						answer: "test answer",
						results: [{ title: "Pricing", url: "https://tavily.com/pricing", content: "plans" }],
						request_id: "req-1",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		};

		await searchTavily({
			...makeParams("pricing site:tavily.com -site:reddit.com"),
			fetch: fetchMock,
		});

		expect(capturedBody).toBeDefined();
		expect(capturedBody?.include_domains).toEqual(["tavily.com"]);
		expect(capturedBody?.exclude_domains).toEqual(["reddit.com"]);
		expect(capturedBody?.query).toBe("pricing");
	});

	it("maps after:/before: to start_date/end_date and retries without them on empty results", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		const capturedBodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBodies.push(JSON.parse(init?.body as string));
				const empty = capturedBodies.length === 1;
				return new Response(
					JSON.stringify({
						answer: "",
						results: empty ? [] : [{ title: "Post", url: "https://example.com/post", content: "text" }],
						request_id: `req-${capturedBodies.length}`,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		};

		const response = await searchTavily({
			...makeParams('"llm agents" after:2026-01-01 before:2026-06-01'),
			fetch: fetchMock,
		});

		expect(capturedBodies).toHaveLength(2);
		expect(capturedBodies[0]?.start_date).toBe("2026-01-01");
		expect(capturedBodies[0]?.end_date).toBe("2026-06-01");
		expect(capturedBodies[0]?.query).toBe('"llm agents"');
		expect(capturedBodies[1]).not.toHaveProperty("start_date");
		expect(capturedBodies[1]).not.toHaveProperty("end_date");
		expect(response.sources).toHaveLength(1);
	});

	it("ignores malformed response fields while preserving valid results", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					answer: 42,
					results: [
						null,
						{ title: 7, url: "https://example.com/valid", content: 99, published_date: false },
						{ title: "Missing URL" },
					],
					request_id: 123,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchTavily({ ...makeParams("robust parsing"), fetch: fetchMock });

		expect(response.answer).toBeUndefined();
		expect(response.requestId).toBeUndefined();
		expect(response.sources).toEqual([
			{
				title: "https://example.com/valid",
				url: "https://example.com/valid",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});

	it("maps an empty result body to an undefined snippet rather than the empty string", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					results: [{ title: "Empty", url: "https://example.com/empty", content: "" }],
					request_id: "req-empty",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchTavily({ ...makeParams("empty body"), fetch: fetchMock });

		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]).toEqual({
			title: "Empty",
			url: "https://example.com/empty",
			snippet: undefined,
			publishedDate: undefined,
			ageSeconds: undefined,
		});
	});

	it("aborts an in-flight request when the caller aborts, re-throwing the abort reason", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		const ac = new AbortController();
		let adapterSignal: AbortSignal | undefined;
		// The mock never resolves on its own — the only way out is a cancelled
		// signal — so a delegation that drops `signal` on the way to `fetch` hangs
		// here instead of passing. `entered` is awaited rather than slept on.
		const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
		const fetchMock: FetchImpl = (_input, init) => {
			adapterSignal = init?.signal ?? undefined;
			markEntered();
			const { promise, reject } = Promise.withResolvers<Response>();
			const rejectAbort = () => reject(init?.signal?.reason ?? new DOMException("aborted", "AbortError"));
			if (init?.signal?.aborted) rejectAbort();
			else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
			return promise;
		};

		const pending = searchTavily({ ...makeParams("cancel me", { fetch: fetchMock, signal: ac.signal }) });
		await entered;
		ac.abort();

		const error = await pending.catch((cause: unknown) => cause);
		expect((error as { name?: string }).name).toBe("AbortError");
		expect((error as { message?: string }).message ?? "").not.toContain("Tavily request failed");
		// The injected fetch must see the *composed* signal, not the raw caller one:
		// that is what keeps the pipeline's hard timeout authoritative.
		expect(adapterSignal).toBeInstanceOf(AbortSignal);
		expect(adapterSignal).not.toBe(ac.signal);
		expect(adapterSignal?.aborted).toBe(true);
	});

	it("hard-times out an in-flight request the caller never aborts", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		let adapterSignal: AbortSignal | undefined;
		let cancelled = false;
		// Real timer on purpose: `withHardTimeout` wraps `AbortSignal.timeout`, which
		// fake timers cannot drive. The test awaits the abort itself, so its cost is
		// the 40 ms budget it is asserting on, not a guessed sleep.
		const fetchMock: FetchImpl = (_input, init) => {
			adapterSignal = init?.signal ?? undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener(
				"abort",
				() => {
					cancelled = true;
					reject(init?.signal?.reason ?? new DOMException("timeout", "TimeoutError"));
				},
				{ once: true },
			);
			return promise;
		};

		const error = await searchTavily({
			...makeParams("stalled socket", { fetch: fetchMock, timeoutMs: 40 }),
		}).catch((cause: unknown) => cause);

		expect(cancelled).toBe(true);
		expect((error as { name?: string }).name).toBe("TimeoutError");
		expect((error as { message?: string }).message ?? "").not.toContain("Tavily request failed");
		expect(adapterSignal).toBeInstanceOf(AbortSignal);
	});
});
