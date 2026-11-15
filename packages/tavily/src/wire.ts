/**
 * The Tavily wire: request bodies and response normalisers, owned here so
 * there is exactly one mapping between camelCase tool parameters and the
 * API's snake_case JSON.
 *
 * The upstream SDK's normalisers are deliberately not reused. Three of them
 * are broken in ways a caller cannot work around — `search` throws when the
 * response has no `images` key, `map` hands back `raw_content` unmapped, and
 * `getResearch` returns the raw snake_case body — so each normaliser here
 * guards its own optional fields and tolerates both casings, which also means
 * an upstream fix cannot break this package.
 */

import type {
	TavilyAutoParameters,
	TavilyCrawlBodyParams,
	TavilyCrawlDoc,
	TavilyCrawlResult,
	TavilyExtractBodyParams,
	TavilyExtractDoc,
	TavilyExtractResult,
	TavilyFailedResult,
	TavilyImage,
	TavilyMapBodyParams,
	TavilyMapDoc,
	TavilyMapResult,
	TavilyResearchBodyParams,
	TavilyResearchQueryParams,
	TavilyResearchRecord,
	TavilyResearchSource,
	TavilySearchBodyParams,
	TavilySearchDoc,
	TavilySearchResult,
	TavilyUsage,
} from "./types";

// ─── Raw shapes ──────────────────────────────────────────────────────────────

/** Every raw field is `unknown` on purpose: nothing is trusted before it is read. */
export interface TavilyRawSearchResponse {
	query?: unknown;
	results?: unknown;
	images?: unknown;
	answer?: unknown;
	response_time?: unknown;
	responseTime?: unknown;
	request_id?: unknown;
	requestId?: unknown;
	favicon?: unknown;
	usage?: unknown;
	auto_parameters?: unknown;
	autoParameters?: unknown;
	[key: string]: unknown;
}

export interface TavilyRawExtractResponse {
	results?: unknown;
	failed_results?: unknown;
	failedResults?: unknown;
	response_time?: unknown;
	responseTime?: unknown;
	base_url?: unknown;
	baseUrl?: unknown;
	request_id?: unknown;
	requestId?: unknown;
	usage?: unknown;
	[key: string]: unknown;
}

export interface TavilyRawCrawlResponse {
	results?: unknown;
	failed_results?: unknown;
	failedResults?: unknown;
	response_time?: unknown;
	responseTime?: unknown;
	base_url?: unknown;
	baseUrl?: unknown;
	request_id?: unknown;
	requestId?: unknown;
	usage?: unknown;
	[key: string]: unknown;
}

export interface TavilyRawMapResponse {
	results?: unknown;
	response_time?: unknown;
	responseTime?: unknown;
	base_url?: unknown;
	baseUrl?: unknown;
	request_id?: unknown;
	requestId?: unknown;
	usage?: unknown;
	[key: string]: unknown;
}

export interface TavilyRawResearchResponse {
	request_id?: unknown;
	requestId?: unknown;
	created_at?: unknown;
	createdAt?: unknown;
	status?: unknown;
	input?: unknown;
	model?: unknown;
	response_time?: unknown;
	responseTime?: unknown;
	content?: unknown;
	sources?: unknown;
	usage?: unknown;
	[key: string]: unknown;
}

// ─── Readers ─────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** First argument that reads as a string; lets a field carry either casing. */
function readFirstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const text = readString(value);
		if (text !== undefined) return text;
	}
	return undefined;
}

function readRequiredString(value: unknown): string {
	return readString(value) ?? "";
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readFirstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const numeric = readNumber(value);
		if (numeric !== undefined) return numeric;
	}
	return undefined;
}

function readUsage(value: unknown): TavilyUsage | undefined {
	return asRecord(value) as TavilyUsage | undefined;
}

/**
 * Image entries in either documented shape — bare URL strings or objects — and
 * anything else (a missing key, `null`, a stray string) reads as no images.
 * This is the guard that keeps `search` from throwing on a valid response.
 */
function readImages(value: unknown): TavilyImage[] {
	const images: TavilyImage[] = [];
	for (const entry of asArray(value)) {
		const bare = readString(entry);
		if (bare !== undefined) {
			const url = bare.trim();
			if (url.length > 0) images.push({ url });
			continue;
		}
		const record = asRecord(entry);
		if (!record) continue;
		const url = readString(record.url)?.trim();
		if (url === undefined || url.length === 0) continue;
		const image: TavilyImage = { url };
		const description = readString(record.description);
		if (description !== undefined) image.description = description;
		images.push(image);
	}
	return images;
}

/** Image lists that the API returns as plain URL arrays (extract, crawl). */
function readUrlStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const urls: string[] = [];
	for (const entry of value) {
		const url = readString(entry)?.trim();
		if (url !== undefined && url.length > 0) urls.push(url);
	}
	return urls;
}

function readFailedResults(value: unknown): TavilyFailedResult[] {
	const failed: TavilyFailedResult[] = [];
	for (const entry of asArray(value)) {
		const record = asRecord(entry);
		if (!record) continue;
		const item: TavilyFailedResult = { url: readRequiredString(record.url) };
		const error = readFirstString(record.error, record.reason);
		if (error !== undefined) item.error = error;
		failed.push(item);
	}
	return failed;
}

/** A report body: text as-is, a structured report as JSON text, nothing as absent. */
function readContent(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return undefined;
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return undefined;
		}
	}
	return String(value);
}

function readSources(value: unknown): TavilyResearchSource[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sources: TavilyResearchSource[] = [];
	for (const entry of value) {
		const url = readString(entry);
		if (url !== undefined) {
			sources.push({ url });
			continue;
		}
		const record = asRecord(entry);
		if (!record) continue;
		const source: TavilyResearchSource = {};
		const sourceUrl = readString(record.url);
		if (sourceUrl !== undefined) source.url = sourceUrl;
		const title = readString(record.title);
		if (title !== undefined) source.title = title;
		sources.push(source);
	}
	return sources;
}

// ─── Builders ──────────────────────────────────────────────────────────────────

/** camelCase → wire name pairs; order is the order keys appear in the body. */
type FieldMap = ReadonlyArray<readonly [string, string]>;

const SEARCH_FIELDS: FieldMap = [
	["query", "query"],
	["searchDepth", "search_depth"],
	["topic", "topic"],
	["days", "days"],
	["maxResults", "max_results"],
	["includeImages", "include_images"],
	["includeImageDescriptions", "include_image_descriptions"],
	["includeAnswer", "include_answer"],
	["includeRawContent", "include_raw_content"],
	["includeDomains", "include_domains"],
	["excludeDomains", "exclude_domains"],
	["includeDomainsMode", "include_domains_mode"],
	["timeRange", "time_range"],
	["chunksPerSource", "chunks_per_source"],
	["country", "country"],
	["startDate", "start_date"],
	["endDate", "end_date"],
	["maxAgeHours", "max_age_hours"],
	["autoParameters", "auto_parameters"],
	["includeFavicon", "include_favicon"],
	["includeUsage", "include_usage"],
	["exactMatch", "exact_match"],
	["fetchTimeout", "fetch_timeout"],
	["cacheFallback", "cache_fallback"],
	["language", "language"],
	["filterByLanguage", "filter_by_language"],
	["safeSearch", "safe_search"],
	["includePublishedDate", "include_published_date"],
	["filterByPublishedDate", "filter_by_published_date"],
];

const EXTRACT_FIELDS: FieldMap = [
	["urls", "urls"],
	["includeImages", "include_images"],
	["extractDepth", "extract_depth"],
	["format", "format"],
	["includeFavicon", "include_favicon"],
	["timeout", "timeout"],
	["includeUsage", "include_usage"],
	["query", "query"],
	["chunksPerSource", "chunks_per_source"],
];

const CRAWL_FIELDS: FieldMap = [
	["url", "url"],
	["maxDepth", "max_depth"],
	["maxBreadth", "max_breadth"],
	["limit", "limit"],
	["extractDepth", "extract_depth"],
	["selectPaths", "select_paths"],
	["selectDomains", "select_domains"],
	["excludePaths", "exclude_paths"],
	["excludeDomains", "exclude_domains"],
	["allowExternal", "allow_external"],
	["includeImages", "include_images"],
	["instructions", "instructions"],
	["format", "format"],
	["timeout", "timeout"],
	["includeFavicon", "include_favicon"],
	["includeUsage", "include_usage"],
	["chunksPerSource", "chunks_per_source"],
];

const MAP_FIELDS: FieldMap = [
	["url", "url"],
	["maxDepth", "max_depth"],
	["maxBreadth", "max_breadth"],
	["limit", "limit"],
	["selectPaths", "select_paths"],
	["selectDomains", "select_domains"],
	["excludePaths", "exclude_paths"],
	["excludeDomains", "exclude_domains"],
	["allowExternal", "allow_external"],
	["instructions", "instructions"],
	["timeout", "timeout"],
	["includeUsage", "include_usage"],
];

const RESEARCH_FIELDS: FieldMap = [
	["input", "input"],
	["model", "model"],
	["outputSchema", "output_schema"],
	["citationFormat", "citation_format"],
	["stream", "stream"],
];

/** Copy declared fields onto the wire, dropping the ones the caller left unset. */
function project(params: object, fields: FieldMap): Record<string, unknown> {
	const source = params as Record<string, unknown>;
	const body: Record<string, unknown> = {};
	for (const [from, to] of fields) {
		const value = source[from];
		if (value !== undefined) body[to] = value;
	}
	return body;
}

/**
 * `POST /search` body.
 *
 * Two rules the built-in `web_search` provider is pinned to:
 * - `topic` appears only when the caller passes it, so Tavily keeps its
 *   default general index instead of narrowing to news.
 * - an explicit `start_date`/`end_date` suppresses `time_range`; sending both
 *   over-restricts the window.
 */
export function buildSearchBody(params: TavilySearchBodyParams): Record<string, unknown> {
	const body = project(params, SEARCH_FIELDS);
	if (params.startDate !== undefined || params.endDate !== undefined) delete body.time_range;
	return body;
}

/** `POST /extract` body. */
export function buildExtractBody(params: TavilyExtractBodyParams): Record<string, unknown> {
	return project(params, EXTRACT_FIELDS);
}

/** `POST /crawl` body. */
export function buildCrawlBody(params: TavilyCrawlBodyParams): Record<string, unknown> {
	return project(params, CRAWL_FIELDS);
}

/** `POST /map` body. */
export function buildMapBody(params: TavilyMapBodyParams): Record<string, unknown> {
	return project(params, MAP_FIELDS);
}

/** `POST /research` body. */
export function buildResearchBody(params: TavilyResearchBodyParams): Record<string, unknown> {
	return project(params, RESEARCH_FIELDS);
}

/** Query string for `GET /research/{id}`. */
export function buildResearchQueryParams(params: TavilyResearchQueryParams): Record<string, unknown> {
	const query: Record<string, unknown> = {};
	if (params.includeUsage !== undefined) query.include_usage = params.includeUsage;
	return query;
}

// ─── Normalisers ─────────────────────────────────────────────────────────────

function normaliseSearchDoc(entry: unknown): TavilySearchDoc {
	const record = asRecord(entry) ?? {};
	const doc: TavilySearchDoc = {
		title: readRequiredString(record.title),
		url: readRequiredString(record.url),
		content: readRequiredString(record.content),
		images: readImages(record.images),
	};
	const rawContent = readFirstString(record.raw_content, record.rawContent);
	if (rawContent !== undefined) doc.rawContent = rawContent;
	const score = readNumber(record.score);
	if (score !== undefined) doc.score = score;
	const publishedDate = readFirstString(record.published_date, record.publishedDate);
	if (publishedDate !== undefined) doc.publishedDate = publishedDate;
	const favicon = readString(record.favicon);
	if (favicon !== undefined) doc.favicon = favicon;
	const id = readString(record.id);
	if (id !== undefined) doc.id = id;
	return doc;
}

function normaliseAutoParameters(value: unknown): TavilyAutoParameters | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const auto: TavilyAutoParameters = {};
	const includeDomains = readUrlStrings(record.include_domains);
	if (includeDomains.length > 0) auto.includeDomains = includeDomains;
	const excludeDomains = readUrlStrings(record.exclude_domains);
	if (excludeDomains.length > 0) auto.excludeDomains = excludeDomains;
	const topic = readString(record.topic);
	if (topic !== undefined) auto.topic = topic;
	const timeRange = readString(record.time_range);
	if (timeRange !== undefined) auto.timeRange = timeRange;
	const searchDepth = readString(record.search_depth);
	if (searchDepth !== undefined) auto.searchDepth = searchDepth;
	return auto;
}

/** Normalise a `POST /search` body. Never throws: a malformed field reads as absent. */
export function normaliseSearch(raw: unknown): TavilySearchResult {
	const body = (asRecord(raw) ?? {}) as TavilyRawSearchResponse;
	const result: TavilySearchResult = {
		results: asArray(body.results).map(normaliseSearchDoc),
		images: readImages(body.images),
	};
	const query = readString(body.query);
	if (query !== undefined) result.query = query;
	const answer = readString(body.answer);
	if (answer !== undefined) result.answer = answer;
	const responseTime = readFirstNumber(body.response_time, body.responseTime);
	if (responseTime !== undefined) result.responseTime = responseTime;
	const requestId = readFirstString(body.request_id, body.requestId);
	if (requestId !== undefined) result.requestId = requestId;
	const favicon = readString(body.favicon);
	if (favicon !== undefined) result.favicon = favicon;
	const usage = readUsage(body.usage);
	if (usage !== undefined) result.usage = usage;
	const autoParameters = normaliseAutoParameters(body.auto_parameters ?? body.autoParameters);
	if (autoParameters !== undefined) result.autoParameters = autoParameters;
	return result;
}

function normaliseExtractDoc(entry: unknown): TavilyExtractDoc {
	const record = asRecord(entry) ?? {};
	const doc: TavilyExtractDoc = {
		url: readRequiredString(record.url),
		images: readUrlStrings(record.images),
	};
	const title = readString(record.title);
	if (title !== undefined) doc.title = title;
	const rawContent = readFirstString(record.raw_content, record.rawContent);
	if (rawContent !== undefined) doc.rawContent = rawContent;
	const favicon = readString(record.favicon);
	if (favicon !== undefined) doc.favicon = favicon;
	const score = readNumber(record.score);
	if (score !== undefined) doc.score = score;
	return doc;
}

/** Normalise a `POST /extract` body; `failedResults` is always an array. */
export function normaliseExtract(raw: unknown): TavilyExtractResult {
	const body = (asRecord(raw) ?? {}) as TavilyRawExtractResponse;
	const result: TavilyExtractResult = {
		results: asArray(body.results).map(normaliseExtractDoc),
		failedResults: readFailedResults(body.failed_results ?? body.failedResults),
	};
	const responseTime = readFirstNumber(body.response_time, body.responseTime);
	if (responseTime !== undefined) result.responseTime = responseTime;
	const baseUrl = readFirstString(body.base_url, body.baseUrl);
	if (baseUrl !== undefined) result.baseUrl = baseUrl;
	const requestId = readFirstString(body.request_id, body.requestId);
	if (requestId !== undefined) result.requestId = requestId;
	const usage = readUsage(body.usage);
	if (usage !== undefined) result.usage = usage;
	return result;
}

function normaliseCrawlDoc(entry: unknown): TavilyCrawlDoc {
	const record = asRecord(entry) ?? {};
	const doc: TavilyCrawlDoc = { url: readRequiredString(record.url) };
	const title = readString(record.title);
	if (title !== undefined) doc.title = title;
	const rawContent = readFirstString(record.raw_content, record.rawContent);
	if (rawContent !== undefined) doc.rawContent = rawContent;
	const content = readString(record.content);
	if (content !== undefined) doc.content = content;
	const score = readNumber(record.score);
	if (score !== undefined) doc.score = score;
	if (record.images !== undefined) doc.images = readUrlStrings(record.images);
	const favicon = readString(record.favicon);
	if (favicon !== undefined) doc.favicon = favicon;
	return doc;
}

/** Normalise a `POST /crawl` body. */
export function normaliseCrawl(raw: unknown): TavilyCrawlResult {
	const body = (asRecord(raw) ?? {}) as TavilyRawCrawlResponse;
	const result: TavilyCrawlResult = { results: asArray(body.results).map(normaliseCrawlDoc) };
	const responseTime = readFirstNumber(body.response_time, body.responseTime);
	if (responseTime !== undefined) result.responseTime = responseTime;
	const baseUrl = readFirstString(body.base_url, body.baseUrl);
	if (baseUrl !== undefined) result.baseUrl = baseUrl;
	const requestId = readFirstString(body.request_id, body.requestId);
	if (requestId !== undefined) result.requestId = requestId;
	const usage = readUsage(body.usage);
	if (usage !== undefined) result.usage = usage;
	const failed = body.failed_results ?? body.failedResults;
	if (failed !== undefined) result.failedResults = readFailedResults(failed);
	return result;
}

/** `children` arrives as URLs or as nodes; both flatten to a URL list. */
function readChildren(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const children: string[] = [];
	for (const entry of value) {
		const url = readString(entry) ?? readString(asRecord(entry)?.url);
		if (url !== undefined && url.length > 0) children.push(url);
	}
	return children;
}

function normaliseMapDoc(entry: unknown): TavilyMapDoc {
	const url = readString(entry);
	if (url !== undefined) return { url };
	const record = asRecord(entry) ?? {};
	const doc: TavilyMapDoc = { url: readRequiredString(record.url) };
	const title = readString(record.title);
	if (title !== undefined) doc.title = title;
	const rawContent = readFirstString(record.raw_content, record.rawContent);
	if (rawContent !== undefined) doc.rawContent = rawContent;
	const children = readChildren(record.children);
	if (children !== undefined) doc.children = children;
	return doc;
}

/**
 * Normalise a `POST /map` body. The API returns either a flat list of URLs or
 * objects carrying `raw_content`, and the upstream SDK forwards that untouched;
 * both arrive here as {@link TavilyMapDoc}.
 */
export function normaliseMap(raw: unknown): TavilyMapResult {
	const body = (asRecord(raw) ?? {}) as TavilyRawMapResponse;
	const result: TavilyMapResult = { results: asArray(body.results).map(normaliseMapDoc) };
	const responseTime = readFirstNumber(body.response_time, body.responseTime);
	if (responseTime !== undefined) result.responseTime = responseTime;
	const baseUrl = readFirstString(body.base_url, body.baseUrl);
	if (baseUrl !== undefined) result.baseUrl = baseUrl;
	const requestId = readFirstString(body.request_id, body.requestId);
	if (requestId !== undefined) result.requestId = requestId;
	const usage = readUsage(body.usage);
	if (usage !== undefined) result.usage = usage;
	return result;
}

/**
 * Map whichever research fields a payload actually carries. Shared by
 * {@link normaliseResearchRecord} and the streaming verbs, which see partial
 * events and must not invent an empty `requestId` for one.
 */
export function normaliseResearchDelta(raw: unknown): Partial<TavilyResearchRecord> {
	const body = (asRecord(raw) ?? {}) as TavilyRawResearchResponse;
	const record: Partial<TavilyResearchRecord> = {};
	const requestId = readFirstString(body.request_id, body.requestId);
	if (requestId !== undefined) record.requestId = requestId;
	const status = readString(body.status);
	if (status !== undefined) record.status = status;
	const createdAt = readFirstString(body.created_at, body.createdAt);
	if (createdAt !== undefined) record.createdAt = createdAt;
	const input = readString(body.input);
	if (input !== undefined) record.input = input;
	const model = readString(body.model);
	if (model !== undefined) record.model = model;
	const responseTime = readFirstNumber(body.response_time, body.responseTime);
	if (responseTime !== undefined) record.responseTime = responseTime;
	const content = readContent(body.content);
	if (content !== undefined) record.content = content;
	const sources = readSources(body.sources);
	if (sources !== undefined) record.sources = sources;
	const usage = readUsage(body.usage);
	if (usage !== undefined) record.usage = usage;
	return record;
}

/**
 * Normalise a research body — the submit response and the `GET /research/{id}`
 * response alike. The latter still arrives from the API in snake_case
 * (`request_id`, `created_at`, `response_time`), which upstream forwards
 * verbatim; both casings are accepted so a future upstream fix is a no-op here.
 */
export function normaliseResearchRecord(raw: unknown): TavilyResearchRecord {
	const delta = normaliseResearchDelta(raw);
	return { ...delta, requestId: delta.requestId ?? "", status: delta.status ?? "" };
}
