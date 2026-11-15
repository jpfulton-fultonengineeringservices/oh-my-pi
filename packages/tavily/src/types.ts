/**
 * Public shapes for `@oh-my-pi/pi-tavily`: the client options, every verb's
 * parameters, and the normalised results the verbs hand back.
 *
 * Nothing here mirrors the wire: raw API field names live in `wire.ts`, and
 * every type in this file is camelCase and safe for a tool renderer, a sqlite
 * ledger or a model-facing payload to consume directly.
 */

import type { createTransport, TavilyTransport } from "@tavily/core";

/** Re-exported so a caller can type its own fake transport without importing `@tavily/core`. */
export type { TavilyTransport };

/** Adapter seam for `createTransport`; lets a test substitute the axios adapter. */
export type TavilyAxiosAdapter = NonNullable<Parameters<typeof createTransport>[0]>["adapter"];

/** Proxy URLs handed to the underlying axios transport. */
export interface TavilyProxyOptions {
	http?: string;
	https?: string;
}

/** Options accepted by {@link createTavilyClient}. */
export interface TavilyClientOptions {
	/** Tavily API key. Falls back to `TAVILY_API_KEY`; an empty value counts as absent. */
	apiKey?: string;
	/** API root. Defaults to `https://api.tavily.com`; tests point it at a local server. */
	apiBaseURL?: string;
	/** `X-Client-Source` value. Defaults to `"omp"`. */
	clientSource?: string;
	/** `X-Client-Name` value. Defaults to `omp/<package version>`. */
	clientName?: string;
	sessionId?: string;
	humanId?: string;
	projectId?: string;
	orgId?: string;
	proxies?: TavilyProxyOptions;
	/** Escape hatch for tests; production code should leave it alone. */
	adapter?: TavilyAxiosAdapter;
}

/** A resolved client: the transport plus the identity it will send. */
export interface TavilyClient {
	/** API key the client resolved to, or `undefined` when running keyless. */
	readonly apiKey: string | undefined;
	/** True when {@link TavilyClient.apiKey} is a non-empty string. */
	readonly hasApiKey: boolean;
	/** Request root the transport posts to. */
	readonly apiBaseURL: string;
	/** Value sent as `X-Client-Source`. */
	readonly clientSource: string;
	/** Value sent as `X-Client-Name`. */
	readonly clientName: string;
	/**
	 * The axios-backed transport. Reach for the verbs instead: they enforce the
	 * keyless gate and normalise the response. This is here for callers that
	 * need an endpoint this package does not model yet.
	 */
	readonly transport: TavilyTransport;
}

/** Credit usage as the API reports it; unrecognised keys pass through untouched. */
export interface TavilyUsage {
	credits?: number;
	[key: string]: unknown;
}

/** One image attached to a search result. */
export interface TavilyImage {
	url: string;
	description?: string;
}

/** One search hit. `images` is always an array — the guard this package exists for. */
export interface TavilySearchDoc {
	title: string;
	url: string;
	content: string;
	rawContent?: string;
	score?: number;
	publishedDate?: string;
	favicon?: string;
	id?: string;
	images: TavilyImage[];
}

/** Search settings Tavily reports it chose itself, when `auto_parameters` was requested. */
export interface TavilyAutoParameters {
	includeDomains?: string[];
	excludeDomains?: string[];
	topic?: string;
	timeRange?: string;
	searchDepth?: string;
}

/** Normalised `POST /search` response. */
export interface TavilySearchResult {
	/** Echo of the query, when the response carries one. */
	query?: string;
	results: TavilySearchDoc[];
	images: TavilyImage[];
	answer?: string;
	responseTime?: number;
	requestId?: string;
	favicon?: string;
	usage?: TavilyUsage;
	autoParameters?: TavilyAutoParameters;
}

/** One extracted page. */
export interface TavilyExtractDoc {
	url: string;
	title?: string;
	rawContent?: string;
	images: string[];
	favicon?: string;
	score?: number;
}

/** A URL the service could not process, with the reason when it gave one. */
export interface TavilyFailedResult {
	url: string;
	error?: string;
}

/** Normalised `POST /extract` response. */
export interface TavilyExtractResult {
	results: TavilyExtractDoc[];
	failedResults: TavilyFailedResult[];
	responseTime?: number;
	usage?: TavilyUsage;
	baseUrl?: string;
	requestId?: string;
}

/** One crawled page. */
export interface TavilyCrawlDoc {
	url: string;
	title?: string;
	rawContent?: string;
	content?: string;
	score?: number;
	images?: string[];
	favicon?: string;
}

/** Normalised `POST /crawl` response. */
export interface TavilyCrawlResult {
	results: TavilyCrawlDoc[];
	responseTime?: number;
	usage?: TavilyUsage;
	failedResults?: TavilyFailedResult[];
	baseUrl?: string;
	requestId?: string;
}

/** One discovered URL. `rawContent` is only present when the crawl-level extract ran. */
export interface TavilyMapDoc {
	url: string;
	title?: string;
	children?: string[];
	rawContent?: string;
}

/** Normalised `POST /map` response. */
export interface TavilyMapResult {
	results: TavilyMapDoc[];
	responseTime?: number;
	usage?: TavilyUsage;
	baseUrl?: string;
	requestId?: string;
}

/** One source cited by a research report. */
export interface TavilyResearchSource {
	url?: string;
	title?: string;
}

/** A research job, whether the service finished it or not. */
export interface TavilyResearchRecord {
	/** Empty string only when the API omitted the id entirely. */
	requestId: string;
	status: string;
	createdAt?: string;
	input?: string;
	model?: string;
	responseTime?: number;
	/** Report body. A structured (`output_schema`) report is returned as JSON text. */
	content?: string;
	sources?: TavilyResearchSource[];
	usage?: TavilyUsage;
}

/** One parsed event from a streaming research call. */
export interface TavilyResearchChunk {
	/** Text to append to the report-in-progress. Empty for events with no text. */
	text: string;
	/** Present when the event carried research fields (`status`, `requestId`, …). */
	record?: Partial<TavilyResearchRecord>;
	/** Set on the terminal chunk when the stream failed; no chunk follows it. */
	error?: TavilyFailure;
}

/** Why a verb did not produce data. */
export type TavilyErrorCode =
	| "auth"
	/** The API answered with a keyless/plan cap envelope; guidance, not a fault. */
	| "keyless-limit"
	/** HTTP 432: a usage/plan limit that is not a cap envelope. */
	| "plan-limit"
	/** HTTP 429 without a cap envelope. */
	| "rate-limit"
	| "timeout"
	/** A 400/422 validation failure: the request was malformed, not limited. */
	| "bad-request"
	/** An HTTP failure with no specific meaning, or a transport/network error. */
	| "transport"
	| "aborted"
	/** Nothing identifiable at all: not an `Error`, no status, no message. */
	| "unknown";

/** A failure a verb resolved to. `detail` is bounded to {@link TAVILY_DETAIL_MAX_CHARS}. */
export interface TavilyFailure {
	code: TavilyErrorCode;
	message: string;
	status?: number;
	detail?: string;
}

/** Every verb's return type: a result or a failure, never a throw. */
export type TavilyResult<T> = { ok: true; data: T } | { ok: false; error: TavilyFailure };

/** Parameters for {@link tavilySearch}. */
export interface TavilySearchParams {
	query: string;
	searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
	/** Omitted from the request body unless passed: Tavily's default index is the right one. */
	topic?: "general" | "news" | "finance";
	days?: number;
	maxResults?: number;
	includeImages?: boolean;
	includeImageDescriptions?: boolean;
	includeAnswer?: boolean | "basic" | "advanced";
	includeRawContent?: boolean | "markdown" | "text";
	includeDomains?: string[];
	excludeDomains?: string[];
	includeDomainsMode?: "restrict" | "prefer";
	timeRange?: "year" | "month" | "week" | "day" | "y" | "m" | "w" | "d";
	chunksPerSource?: number;
	country?: string;
	/** `YYYY-MM-DD`. Wins over {@link TavilySearchParams.timeRange}. */
	startDate?: string;
	/** `YYYY-MM-DD`. Wins over {@link TavilySearchParams.timeRange}. */
	endDate?: string;
	maxAgeHours?: number;
	autoParameters?: boolean;
	includeFavicon?: boolean;
	includeUsage?: boolean;
	exactMatch?: boolean;
	fetchTimeout?: number;
	cacheFallback?: boolean;
	language?: string;
	filterByLanguage?: boolean;
	safeSearch?: boolean;
	includePublishedDate?: boolean;
	filterByPublishedDate?: boolean;
	/** HTTP budget in seconds; the API's own default applies when unset. */
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

/** Parameters for {@link tavilyExtract}. */
export interface TavilyExtractParams {
	urls: string[];
	includeImages?: boolean;
	extractDepth?: "basic" | "advanced";
	format?: "markdown" | "text";
	includeFavicon?: boolean;
	includeUsage?: boolean;
	/** Rerank query: biases which chunks come back per source. */
	query?: string;
	chunksPerSource?: number;
	/** Server-side fetch budget, also sent in the request body. */
	timeout?: number;
	/** HTTP budget in seconds; the API's own default applies when unset. */
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

/** Parameters for {@link tavilyCrawl}. */
export interface TavilyCrawlParams {
	url: string;
	maxDepth?: number;
	maxBreadth?: number;
	limit?: number;
	instructions?: string;
	extractDepth?: "basic" | "advanced";
	selectPaths?: string[];
	selectDomains?: string[];
	excludePaths?: string[];
	excludeDomains?: string[];
	allowExternal?: boolean;
	includeImages?: boolean;
	includeFavicon?: boolean;
	format?: "markdown" | "text";
	chunksPerSource?: number;
	includeUsage?: boolean;
	/** Server-side fetch budget, also sent in the request body. */
	timeout?: number;
	/** HTTP budget in seconds; the API's own default applies when unset. */
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

/** Parameters for {@link tavilyMap}. */
export interface TavilyMapParams {
	url: string;
	limit?: number;
	maxDepth?: number;
	maxBreadth?: number;
	selectPaths?: string[];
	selectDomains?: string[];
	excludePaths?: string[];
	excludeDomains?: string[];
	allowExternal?: boolean;
	instructions?: string;
	includeUsage?: boolean;
	/** Server-side fetch budget, also sent in the request body. */
	timeout?: number;
	/** HTTP budget in seconds; the API's own default applies when unset. */
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

/** Parameters for {@link tavilyResearch} and {@link tavilyResearchStream}. */
export interface TavilyResearchParams {
	input: string;
	model?: "mini" | "pro" | "auto";
	/** JSON Schema for a structured report. */
	outputSchema?: Record<string, unknown>;
	citationFormat?: "numbered" | "mla" | "apa" | "chicago";
	/** Set by {@link tavilyResearchStream}; a direct call should leave it unset. */
	stream?: boolean;
	/**
	 * HTTP budget in seconds. `/research` has no server-side timeout, so this is
	 * the only guard, and it is never sent in the body. `timeout` is the same
	 * budget under the name the tool surface advertises; `timeoutSeconds` is the
	 * name every other verb uses.
	 */
	timeout?: number;
	/** HTTP budget in seconds; `timeoutSeconds` wins when both are given. */
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

/** Parameters for {@link tavilyResearchStatus}. */
export interface TavilyResearchStatusParams {
	requestId: string;
	includeUsage?: boolean;
	/** HTTP budget in seconds; the API's own default applies when unset. */
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

/** Body fields {@link buildSearchBody} accepts: search parameters minus transport-only ones. */
export type TavilySearchBodyParams = Omit<TavilySearchParams, "signal" | "timeoutSeconds">;

/** Body fields {@link buildExtractBody} accepts. */
export type TavilyExtractBodyParams = Omit<TavilyExtractParams, "signal" | "timeoutSeconds">;

/** Body fields {@link buildCrawlBody} accepts. */
export type TavilyCrawlBodyParams = Omit<TavilyCrawlParams, "signal" | "timeoutSeconds">;

/** Body fields {@link buildMapBody} accepts. */
export type TavilyMapBodyParams = Omit<TavilyMapParams, "signal" | "timeoutSeconds">;

/** Body fields {@link buildResearchBody} accepts. */
/** `timeout` is excluded too: the research budget is ours, never the API's. */
export type TavilyResearchBodyParams = Omit<TavilyResearchParams, "signal" | "timeoutSeconds" | "timeout">;

/** Query fields {@link buildResearchQueryParams} accepts. */
export type TavilyResearchQueryParams = Omit<TavilyResearchStatusParams, "signal" | "timeoutSeconds">;
