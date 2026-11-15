/**
 * The wire mapping: request bodies out, normalised results back.
 *
 * These are the tests for the reason this package re-implements what
 * `@tavily/core`'s own normalisers do. Three of them are regressions against
 * behaviour that a real response triggers and the SDK forwards raw:
 * `search` images in an undocumented shape, `map` results that are bare strings
 * or objects carrying `raw_content`, and research fields that arrive in
 * snake_case from `GET /research/{id}`.
 */

import { describe, expect, it } from "bun:test";
import {
	buildCrawlBody,
	buildExtractBody,
	buildMapBody,
	buildResearchBody,
	buildResearchQueryParams,
	buildSearchBody,
	normaliseCrawl,
	normaliseExtract,
	normaliseMap,
	normaliseResearchDelta,
	normaliseResearchRecord,
	normaliseSearch,
} from "../src/index";

describe("buildSearchBody", () => {
	it("maps camelCase parameters onto the snake_case wire keys", () => {
		const body = buildSearchBody({
			query: "tree-sitter wasm",
			searchDepth: "advanced",
			maxResults: 5,
			includeAnswer: true,
			includeRawContent: "markdown",
			includeDomains: ["docs.example.com"],
			excludeDomains: ["forum.example.com"],
			includeImages: true,
			includeImageDescriptions: true,
			includeFavicon: true,
			timeRange: "week",
			country: "Germany",
			exactMatch: true,
			days: 7,
			includeUsage: true,
		});

		expect(body).toEqual({
			query: "tree-sitter wasm",
			search_depth: "advanced",
			max_results: 5,
			include_answer: true,
			include_raw_content: "markdown",
			include_domains: ["docs.example.com"],
			exclude_domains: ["forum.example.com"],
			include_images: true,
			include_image_descriptions: true,
			include_favicon: true,
			time_range: "week",
			country: "Germany",
			exact_match: true,
			days: 7,
			include_usage: true,
		});
	});

	it("omits topic unless the caller asks for it, so Tavily keeps its default index", () => {
		// `toContain`, never `toInclude`: bun 1.4.4 does not treat `toInclude` as array
		// membership, so `.not.toInclude` on keys passes whether the key is there or not.
		expect(Object.keys(buildSearchBody({ query: "x" }))).not.toContain("topic");
		expect(buildSearchBody({ query: "x", topic: "news" }).topic).toBe("news");
	});

	it("suppresses time_range when an explicit date window is given", () => {
		const withDates = buildSearchBody({ query: "x", timeRange: "week", startDate: "2026-01-01" });
		expect(Object.keys(withDates)).not.toContain("time_range");
		expect(withDates.start_date).toBe("2026-01-01");

		const withRangeOnly = buildSearchBody({ query: "x", timeRange: "week" });
		expect(withRangeOnly.time_range).toBe("week");
		expect(Object.keys(withRangeOnly)).not.toContain("start_date");
	});

	it("never emits a key the caller left unset, and never emits undefined", () => {
		const body = buildSearchBody({ query: "x" });
		expect(Object.keys(body)).toEqual(["query"]);
		expect(Object.values(buildSearchBody({ query: "x", maxResults: undefined }))).not.toContain(undefined);
	});
});

describe("request bodies", () => {
	it("carry no camelCase keys on any verb", () => {
		const bodies = [
			buildSearchBody({ query: "x", searchDepth: "basic", maxResults: 1 }),
			buildExtractBody({ urls: ["https://a"], extractDepth: "advanced", chunksPerSource: 3 }),
			buildCrawlBody({ url: "https://a", maxDepth: 2, selectPaths: ["/docs"], allowExternal: false }),
			buildMapBody({ url: "https://a", maxBreadth: 10, excludeDomains: ["x.com"] }),
			buildResearchBody({ input: "x", outputSchema: { type: "object" }, citationFormat: "mla" }),
		];
		for (const body of bodies) {
			for (const key of Object.keys(body)) {
				expect(key).not.toMatch(/[A-Z]/);
			}
		}
	});

	it("maps extract, crawl, map and research parameters field by field", () => {
		expect(buildExtractBody({ urls: ["https://a"], includeImages: true, includeFavicon: true, timeout: 5 })).toEqual({
			urls: ["https://a"],
			include_images: true,
			include_favicon: true,
			timeout: 5,
		});
		expect(
			buildCrawlBody({
				url: "https://a",
				maxDepth: 3,
				maxBreadth: 4,
				limit: 5,
				extractDepth: "advanced",
				selectDomains: ["a.com"],
				excludePaths: ["/private"],
				excludeDomains: ["b.com"],
				allowExternal: true,
				instructions: "docs only",
				format: "markdown",
				chunksPerSource: 3,
			}),
		).toEqual({
			url: "https://a",
			max_depth: 3,
			max_breadth: 4,
			limit: 5,
			extract_depth: "advanced",
			select_domains: ["a.com"],
			exclude_paths: ["/private"],
			exclude_domains: ["b.com"],
			allow_external: true,
			instructions: "docs only",
			format: "markdown",
			chunks_per_source: 3,
		});
		expect(buildMapBody({ url: "https://a", selectPaths: ["/x"], allowExternal: false, instructions: "i" })).toEqual({
			url: "https://a",
			select_paths: ["/x"],
			allow_external: false,
			instructions: "i",
		});
		expect(
			buildResearchBody({ input: "why", model: "pro", outputSchema: { type: "object" }, citationFormat: "apa" }),
		).toEqual({
			input: "why",
			model: "pro",
			output_schema: { type: "object" },
			citation_format: "apa",
		});
	});

	it("does not add a stream flag to a research body that did not ask for one", () => {
		expect(Object.keys(buildResearchBody({ input: "why" }))).not.toContain("stream");
		expect(buildResearchBody({ input: "why", stream: true }).stream).toBe(true);
	});

	it("sends include_usage on the research status query only when set", () => {
		expect(buildResearchQueryParams({ requestId: "r1" })).toEqual({});
		expect(buildResearchQueryParams({ requestId: "r1", includeUsage: true })).toEqual({ include_usage: true });
		expect(buildResearchQueryParams({ requestId: "r1", includeUsage: false })).toEqual({ include_usage: false });
	});
});

describe("normaliseSearch", () => {
	it("reads every documented and undocumented image shape without throwing", () => {
		const shaped = normaliseSearch({
			results: [
				{ title: "a", url: "https://a", content: "c", images: ["https://img/1.png", "  ", ""] },
				{ title: "b", url: "https://b", content: "c", images: [{ url: "https://i/2.png", description: "two" }] },
				{ title: "c", url: "https://c", content: "c", images: "https://not-an-array" },
				{ title: "d", url: "https://d", content: "c", images: null },
				{ title: "e", url: "https://e", content: "c" },
				{ title: "f", url: "https://f", content: "c", images: [{ description: "no url" }, 7, null] },
			],
		});

		expect(shaped.results.map(doc => doc.images)).toEqual([
			[{ url: "https://img/1.png" }],
			[{ url: "https://i/2.png", description: "two" }],
			[],
			[],
			[],
			[],
		]);
	});

	it("accepts either casing for the fields the API sends inconsistently", () => {
		const snake = normaliseSearch({
			results: [{ title: "a", url: "https://a", content: "c", raw_content: "raw", published_date: "2026-01-02" }],
			response_time: 1.5,
			request_id: "req-1",
		});
		const camel = normaliseSearch({
			results: [{ title: "a", url: "https://a", content: "c", rawContent: "raw", publishedDate: "2026-01-02" }],
			responseTime: 1.5,
			requestId: "req-1",
		});

		expect(snake.results[0]?.rawContent).toBe("raw");
		expect(snake.results[0]?.publishedDate).toBe("2026-01-02");
		expect(camel).toEqual(snake);
	});

	it("reads a malformed body as empty instead of throwing", () => {
		for (const raw of [undefined, null, 42, "not json", [], true]) {
			expect(normaliseSearch(raw)).toEqual({ results: [], images: [] });
		}
		expect(normaliseSearch({ results: "nope", images: { url: "x" } })).toEqual({ results: [], images: [] });
	});

	it("drops junk entries from the top-level image list and keeps descriptions", () => {
		const result = normaliseSearch({
			images: [
				"https://i/1.png",
				{ url: "https://i/2.png" },
				{ url: "  " },
				{ url: "https://i/3.png", description: "three" },
			],
		});
		expect(result.images).toEqual([
			{ url: "https://i/1.png" },
			{ url: "https://i/2.png" },
			{ url: "https://i/3.png", description: "three" },
		]);
	});

	it("passes usage through untouched and reads auto_parameters defensively", () => {
		const result = normaliseSearch({
			usage: { credits: 2, plan: "pro" },
			auto_parameters: { include_domains: ["a.com", 5], topic: "news", time_range: 3, search_depth: "basic" },
			query: "x",
			answer: "because",
		});
		expect(result.usage).toEqual({ credits: 2, plan: "pro" });
		expect(result.autoParameters).toEqual({ includeDomains: ["a.com"], topic: "news", searchDepth: "basic" });
		expect(result.query).toBe("x");
		expect(result.answer).toBe("because");
	});

	it("omits optional fields the response did not carry", () => {
		const result = normaliseSearch({ results: [{ url: "https://a" }] });
		expect(result.results[0]).toEqual({ title: "", url: "https://a", content: "", images: [] });
		expect(Object.keys(result)).toEqual(["results", "images"]);
	});
});

describe("normaliseExtract", () => {
	it("always yields arrays and folds failed_results reasons", () => {
		const result = normaliseExtract({
			results: [
				{ url: "https://a", raw_content: "# A", images: ["https://i/1.png", "", 5], favicon: "f", score: 0.5 },
				{ url: "https://b", images: "nope" },
			],
			failed_results: [{ url: "https://c", reason: "403" }, { url: "https://d", error: "timeout" }, "junk"],
			base_url: "https://a",
		});

		expect(result.results[0]).toEqual({
			url: "https://a",
			images: ["https://i/1.png"],
			rawContent: "# A",
			favicon: "f",
			score: 0.5,
		});
		expect(result.results[1]?.images).toEqual([]);
		expect(result.failedResults).toEqual([
			{ url: "https://c", error: "403" },
			{ url: "https://d", error: "timeout" },
		]);
		expect(result.baseUrl).toBe("https://a");
	});

	it("reads a malformed body as empty", () => {
		expect(normaliseExtract(undefined)).toEqual({ results: [], failedResults: [] });
		expect(normaliseExtract({ results: null, failed_results: "x" })).toEqual({ results: [], failedResults: [] });
	});
});

describe("normaliseCrawl", () => {
	it("distinguishes an absent image list from an empty one", () => {
		const result = normaliseCrawl({
			results: [
				{ url: "https://a", title: "A", raw_content: "r", content: "c", score: 1 },
				{ url: "https://b", images: [] },
				{ url: "https://c", images: ["https://i/1.png", null] },
			],
		});
		expect("images" in (result.results[0] ?? {})).toBe(false);
		expect(result.results[1]?.images).toEqual([]);
		expect(result.results[2]?.images).toEqual(["https://i/1.png"]);
	});

	it("omits failedResults when the response had none, and reads both casings", () => {
		expect("failedResults" in normaliseCrawl({ results: [] })).toBe(false);
		expect(normaliseCrawl({ results: [], failedResults: [{ url: "u" }] }).failedResults).toEqual([{ url: "u" }]);
	});
});

describe("normaliseMap", () => {
	it("accepts bare URL strings and objects alike", () => {
		const flat = normaliseMap({ results: ["https://a", "https://b"] });
		expect(flat.results).toEqual([{ url: "https://a" }, { url: "https://b" }]);

		const nested = normaliseMap({
			results: [
				{
					url: "https://a",
					title: "A",
					raw_content: "body",
					children: ["https://a/1", { url: "https://a/2" }, "", null],
				},
			],
		});
		expect(nested.results[0]).toEqual({
			url: "https://a",
			title: "A",
			rawContent: "body",
			children: ["https://a/1", "https://a/2"],
		});
	});

	it("reads a malformed body as empty", () => {
		expect(normaliseMap(undefined)).toEqual({ results: [] });
		expect(normaliseMap({ results: [null, 3] })).toEqual({ results: [{ url: "" }, { url: "" }] });
	});
});

describe("research normalisation", () => {
	it("does not invent a requestId for a partial streaming event", () => {
		expect(normaliseResearchDelta({ status: "processing" })).toEqual({ status: "processing" });
		expect(normaliseResearchDelta({})).toEqual({});
	});

	it("fills the two required fields on a full record", () => {
		expect(normaliseResearchRecord({})).toEqual({ requestId: "", status: "" });
		expect(normaliseResearchRecord({ request_id: "r1", status: "complete" })).toEqual({
			requestId: "r1",
			status: "complete",
		});
	});

	it("reads the snake_case body GET /research/{id} actually returns", () => {
		const record = normaliseResearchRecord({
			request_id: "r1",
			created_at: "2026-11-14T00:00:00Z",
			status: "complete",
			input: "why",
			model: "mini",
			response_time: 12.5,
			content: { summary: "because" },
			sources: ["https://a", { url: "https://b", title: "B" }, 7],
			usage: { credits: 4 },
		});
		expect(record).toEqual({
			requestId: "r1",
			createdAt: "2026-11-14T00:00:00Z",
			status: "complete",
			input: "why",
			model: "mini",
			responseTime: 12.5,
			content: '{"summary":"because"}',
			sources: [{ url: "https://a" }, { url: "https://b", title: "B" }],
			usage: { credits: 4 },
		});
	});

	it("leaves a missing report absent rather than an empty string", () => {
		expect("content" in normaliseResearchRecord({ request_id: "r1" })).toBe(false);
		expect(normaliseResearchRecord({ content: 0 }).content).toBe("0");
	});
});
