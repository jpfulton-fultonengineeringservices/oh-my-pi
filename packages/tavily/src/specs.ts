/**
 * The Tavily tool surface as data.
 *
 * Plain JSON-shaped data on purpose — no functions, no schema builders, no
 * validation. The agent-facing tools live in the config repo and build their
 * `pi.zod` arguments from this table, so each verb's description and each
 * field's wording have exactly one source. Zod objects from here would not be
 * interchangeable with the host's zod namespace, which is why nothing is
 * constructed at all.
 *
 * The field sets are the curated model-facing subset, not the whole API.
 */

/** The verbs {@link TAVILY_TOOL_SPECS} covers, matching the exported functions. */
export type TavilyVerb = "search" | "extract" | "crawl" | "map" | "research" | "research_status";

/** JSON-Schema-ish types the config repo maps onto `pi.zod`. */
export type TavilySpecFieldType =
	| "string"
	| "boolean"
	| "number"
	| "integer"
	| "array"
	| "object"
	/** Fields Tavily accepts as either a flag or a mode string, e.g. `includeAnswer`. */
	| "boolean|string";

/** One advertised parameter. */
export interface TavilySpecField {
	type: TavilySpecFieldType;
	description: string;
	/** Omitted means optional. */
	required?: boolean;
	/** Allowed values; for `boolean|string` fields these are the mixed literals. */
	enum?: readonly (string | boolean)[];
	/** Element type for `array` fields. Only `"string"` is used. */
	items?: "string";
	minimum?: number;
	maximum?: number;
}

/** One verb's advertisement: what it is for and what it accepts. */
export interface TavilyToolSpec {
	description: string;
	fields: Record<string, TavilySpecField>;
}

const SEARCH_DEPTH = ["basic", "advanced", "fast", "ultra-fast"] as const;
const TOPIC = ["general", "news", "finance"] as const;
const TIME_RANGE = ["year", "month", "week", "day", "y", "m", "w", "d"] as const;
const EXTRACT_DEPTH = ["basic", "advanced"] as const;
const FORMAT = ["markdown", "text"] as const;
const RESEARCH_MODEL = ["mini", "pro", "auto"] as const;
const CITATION_FORMAT = ["numbered", "mla", "apa", "chicago"] as const;

const INCLUDE_USAGE_FIELD: TavilySpecField = {
	type: "boolean",
	description: "Ask the API to report credits consumed, returned as `usage.credits`.",
};

export const TAVILY_TOOL_SPECS: Record<TavilyVerb, TavilyToolSpec> = {
	search: {
		description:
			"Search the web through Tavily and get ranked pages with content snippets. " +
			"Returns titles, URLs, snippets and an optional answer; use tavily_extract to pull a page in full.",
		fields: {
			query: { type: "string", description: "Search query.", required: true },
			searchDepth: {
				type: "string",
				enum: SEARCH_DEPTH,
				description:
					"Retrieval strategy: `basic` for quick retrieval, `advanced` for deeper coverage, `fast` and `ultra-fast` for lower latency.",
			},
			topic: {
				type: "string",
				enum: TOPIC,
				description:
					"Search category. Omit it to keep Tavily's default general index; `news` narrows the index and hurts technical queries.",
			},
			timeRange: {
				type: "string",
				enum: TIME_RANGE,
				description: "Relative recency window. Ignored when `startDate` or `endDate` is given.",
			},
			days: {
				type: "integer",
				minimum: 1,
				description: "Lookback in days, for `topic: 'news'` searches.",
			},
			maxResults: {
				type: "integer",
				minimum: 0,
				maximum: 20,
				description: "How many results to return.",
			},
			includeAnswer: {
				type: "boolean|string",
				enum: [false, true, "basic", "advanced"],
				description: "Also return a generated answer; `true` selects basic answer mode.",
			},
			includeRawContent: {
				type: "boolean|string",
				enum: [false, "markdown", "text"],
				description: "Return each page's content in the given format, or `false` to omit it.",
			},
			includeDomains: {
				type: "array",
				items: "string",
				description: "Domains to restrict or prefer, per `includeDomainsMode`.",
			},
			excludeDomains: { type: "array", items: "string", description: "Domains to omit." },
			includeImages: { type: "boolean", description: "Return images alongside the text results." },
			includeImageDescriptions: {
				type: "boolean",
				description: "Ask for a description of each returned image.",
			},
			includeFavicon: { type: "boolean", description: "Return each site's icon URL." },
			country: { type: "string", description: "Bias results toward a country, e.g. `Germany`." },
			exactMatch: {
				type: "boolean",
				description: "Require quoted phrases in the query to match exactly.",
			},
			includeUsage: INCLUDE_USAGE_FIELD,
		},
	},
	extract: {
		description:
			"Fetch the full content of specific URLs through Tavily, as markdown or text. " +
			"Use it after a search to read the pages that mattered.",
		fields: {
			urls: { type: "array", items: "string", description: "URLs to extract.", required: true },
			extractDepth: {
				type: "string",
				enum: EXTRACT_DEPTH,
				description: "`advanced` retries with a deeper extraction pipeline when `basic` returns little.",
			},
			format: {
				type: "string",
				enum: FORMAT,
				description: "Content format to return.",
			},
			query: {
				type: "string",
				description: "Rerank query: biases which chunks of each page come back.",
			},
			chunksPerSource: {
				type: "integer",
				minimum: 1,
				maximum: 3,
				description: "Content chunks returned per source.",
			},
			includeImages: { type: "boolean", description: "Return image URLs found on the page." },
			includeFavicon: { type: "boolean", description: "Return the site icon URL." },
			timeout: {
				type: "number",
				minimum: 1,
				description: "Server-side fetch budget in seconds, sent to the API.",
			},
			includeUsage: INCLUDE_USAGE_FIELD,
		},
	},
	crawl: {
		description: "Crawl a site from a start URL through Tavily and return the content of the pages it reaches.",
		fields: {
			url: { type: "string", description: "Start URL.", required: true },
			maxDepth: {
				type: "integer",
				minimum: 1,
				maximum: 5,
				description: "How many link hops to follow from the start URL.",
			},
			maxBreadth: { type: "integer", minimum: 1, description: "How many links to follow per page." },
			limit: { type: "integer", minimum: 1, description: "Maximum number of pages to return." },
			instructions: {
				type: "string",
				description: "Natural-language guidance for which pages the crawler should prefer.",
			},
			extractDepth: {
				type: "string",
				enum: EXTRACT_DEPTH,
				description: "Extraction depth applied to each crawled page.",
			},
			selectPaths: {
				type: "array",
				items: "string",
				description: "Path patterns (regex) to keep, e.g. `/docs/.*`.",
			},
			excludePaths: { type: "array", items: "string", description: "Path patterns (regex) to drop." },
			selectDomains: { type: "array", items: "string", description: "Domains to stay inside." },
			excludeDomains: { type: "array", items: "string", description: "Domains to skip." },
			allowExternal: { type: "boolean", description: "Allow links that leave the start domain." },
			includeImages: { type: "boolean", description: "Return image URLs per page." },
			includeFavicon: { type: "boolean", description: "Return the site icon URL." },
			format: { type: "string", enum: FORMAT, description: "Content format per page." },
			chunksPerSource: {
				type: "integer",
				minimum: 1,
				maximum: 3,
				description: "Content chunks returned per crawled page.",
			},
			includeUsage: INCLUDE_USAGE_FIELD,
		},
	},
	map: {
		description:
			"Discover the URL structure of a site through Tavily — a sitemap-like list, without content unless the site returns it.",
		fields: {
			url: { type: "string", description: "Start URL.", required: true },
			limit: { type: "integer", minimum: 1, description: "Maximum number of URLs to return." },
			maxDepth: { type: "integer", minimum: 1, description: "How many link hops to follow." },
			maxBreadth: { type: "integer", minimum: 1, description: "How many links to follow per page." },
			selectPaths: { type: "array", items: "string", description: "Path patterns (regex) to keep." },
			selectDomains: { type: "array", items: "string", description: "Domains to stay inside." },
			excludePaths: { type: "array", items: "string", description: "Path patterns (regex) to drop." },
			excludeDomains: { type: "array", items: "string", description: "Domains to skip." },
			allowExternal: { type: "boolean", description: "Allow links that leave the start domain." },
			instructions: {
				type: "string",
				description: "Natural-language guidance for which URLs to prefer.",
			},
			timeout: { type: "number", minimum: 1, description: "Server-side fetch budget in seconds." },
			includeUsage: INCLUDE_USAGE_FIELD,
		},
	},
	research: {
		description:
			"Submit a deep research task to Tavily: it plans, searches, reads sources and writes a cited report. " +
			"Long-running — the call returns a `requestId` to poll with tavily_research_status.",
		fields: {
			input: {
				type: "string",
				description: "The research question or task, in as much detail as it needs.",
				required: true,
			},
			model: {
				type: "string",
				enum: RESEARCH_MODEL,
				description: "`mini` for a faster, shallower report, `pro` for the deepest, `auto` to choose.",
			},
			outputSchema: {
				type: "object",
				description: "JSON Schema for a structured report instead of prose.",
			},
			citationFormat: {
				type: "string",
				enum: CITATION_FORMAT,
				description: "How the report cites its sources.",
			},
			stream: {
				type: "boolean",
				description: "Stream the report as it is written. Set by the streaming entrypoint; leave unset to submit.",
			},
			timeout: {
				type: "number",
				minimum: 1,
				description:
					"HTTP budget in seconds. This endpoint has no server-side timeout, so set one when the call must not wait forever.",
			},
		},
	},
	research_status: {
		description:
			"Read a Tavily research job: its status while running, and the finished report plus sources once it has completed.",
		fields: {
			requestId: {
				type: "string",
				description: "The `requestId` returned by tavily_research.",
				required: true,
			},
			includeUsage: INCLUDE_USAGE_FIELD,
		},
	},
};
