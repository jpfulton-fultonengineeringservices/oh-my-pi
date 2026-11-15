/**
 * Tavily Web Search Provider
 *
 * Uses Tavily's agent-focused search API to return structured results with an
 * optional synthesized answer. All HTTP goes through `@oh-my-pi/pi-tavily`:
 * this module owns the `web_search`-side contract only — credential lookup,
 * the pinned wire defaults, the hard timeout, and the `SearchResponse`
 * mapping. A caller-supplied `fetch` is honoured by wrapping it into the
 * package's axios adapter; with none supplied the global `fetch` runs through
 * the same adapter, so abort and timeout enforcement live in exactly one place.
 */
import {
	type ApiKey,
	type AuthStorage,
	type FetchImpl,
	getEnvApiKey,
	NO_AUTH_SENTINEL,
	withAuth,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	buildSearchBody,
	createTavilyClient,
	tavilySearch,
	type TavilyAxiosAdapter,
	type TavilySearchResult,
	type TavilySearchParams as TavilyClientSearchParams,
} from "@oh-my-pi/pi-tavily";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, siteHosts, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;

/** Kept in sync with {@link withAuth}'s `missingKeyMessage`. */
const MISSING_KEY_MESSAGE =
	'Tavily credentials not found. Set TAVILY_API_KEY or configure an API key for provider "tavily".';

export interface TavilySearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	/** `site:` hosts mapped to Tavily's `include_domains`. */
	include_domains?: string[];
	/** `-site:` hosts mapped to Tavily's `exclude_domains`. */
	exclude_domains?: string[];
	/** `after:` inclusive lower bound, ISO `YYYY-MM-DD`, mapped to `start_date`. */
	start_date?: string;
	/** `before:` upper bound, ISO `YYYY-MM-DD`, mapped to `end_date`. */
	end_date?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

function getErrorMessage(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	const record = asRecord(value);
	if (!record) return null;
	for (const key of ["detail", "error", "message"]) {
		const message = getErrorMessage(record[key]);
		if (message) return message;
	}
	return null;
}

/** Find Tavily API key through AuthStorage's unified refresh pipeline. */
export async function findApiKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	return (await authStorage.keys.get("tavily", sessionId, { signal })) ?? null;
}

/**
 * The provider's pinned camelCase search parameters.
 *
 * Tavily's `topic` (general/news/finance) and `time_range` are orthogonal
 * dimensions in the upstream API. Recency is a temporal filter only; it must
 * not narrow the index to news-only, which would break technical queries
 * (release notes, docs, GitHub) whenever a user sets --recency. `topic` is
 * therefore never set here, and {@link buildSearchBody} drops `time_range`
 * whenever explicit `start_date`/`end_date` bounds are present.
 */
function toClientSearchParams(params: TavilySearchParams): TavilyClientSearchParams {
	const clientParams: TavilyClientSearchParams = {
		query: params.query,
		searchDepth: "basic",
		maxResults: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
		includeAnswer: "advanced",
		includeRawContent: false,
	};
	if (params.include_domains?.length) clientParams.includeDomains = params.include_domains;
	if (params.exclude_domains?.length) clientParams.excludeDomains = params.exclude_domains;
	if (params.start_date) clientParams.startDate = params.start_date;
	if (params.end_date) clientParams.endDate = params.end_date;
	if (params.recency) clientParams.timeRange = params.recency;
	return clientParams;
}

/** Exported for testing. Builds the Tavily request body from unified params. */
export function buildRequestBody(params: TavilySearchParams): Record<string, unknown> {
	return buildSearchBody(toClientSearchParams(params));
}

/** A non-2xx Tavily answer, captured before the vendor transport flattens it. */
interface TavilyHttpExchange {
	status: number;
	statusText: string;
	body: string;
}

/** Rejection carrying the HTTP exchange; see {@link createFetchAdapter}. */
class TavilyHttpExchangeError extends Error {
	constructor(exchange: TavilyHttpExchange) {
		super(`Tavily API error (${exchange.status})`);
		this.name = "TavilyHttpExchangeError";
	}
}

/** Plain header record from an axios `AxiosHeaders` (or a plain object). */
function toHeaderRecord(headers: unknown): Record<string, string> {
	const source = headers as { toJSON?: () => Record<string, unknown> } | undefined;
	const entries = Object.entries(source?.toJSON ? source.toJSON() : ((headers ?? {}) as Record<string, unknown>));
	const record: Record<string, string> = {};
	for (const [name, value] of entries) {
		if (value === undefined || value === null) continue;
		record[name] = typeof value === "string" ? value : String(value);
	}
	return record;
}

/**
 * Adapt a caller-supplied {@link FetchImpl} to the package's axios adapter.
 *
 * The vendor transport is axios, so the injected `fetch` has to speak axios'
 * adapter contract: `config.data` arrives already serialised, the request
 * headers (including `Authorization`) arrive on `config.headers`, and a
 * response `validateStatus` rejects must be *rejected* by the adapter — axios
 * applies `validateStatus` inside its own adapters only, so resolving a 401
 * would hand an error body back as a successful (empty) search. The exchange
 * is recorded in `exchanges` because the transport's error mapping keeps an
 * HTTP status only on a real `AxiosError`, which a hand-written adapter cannot
 * produce without depending on axios itself.
 */
function createFetchAdapter(
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	exchanges: TavilyHttpExchange[],
): NonNullable<TavilyAxiosAdapter> {
	return async config => {
		const data = config.data;
		const body = data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data);
		const response = await fetchImpl(config.url ?? "", {
			method: (config.method ?? "post").toUpperCase(),
			headers: toHeaderRecord(config.headers),
			body,
			signal,
		});
		const text = await response.text();
		const accepted = config.validateStatus ? config.validateStatus(response.status) : response.ok;
		if (!accepted) {
			const exchange: TavilyHttpExchange = { status: response.status, statusText: response.statusText, body: text };
			exchanges.push(exchange);
			throw new TavilyHttpExchangeError(exchange);
		}
		return {
			data: JSON.parse(text) as unknown,
			status: response.status,
			statusText: response.statusText,
			headers: {},
			config,
			request: {},
		};
	};
}

/** Map a captured non-2xx exchange onto the provider error the chain expects. */
function toHttpError(exchange: TavilyHttpExchange): SearchProviderError {
	const classified = classifyProviderHttpError("tavily", exchange.status, exchange.body);
	if (classified) return classified;
	let message = exchange.body.trim();
	if (message.length === 0) {
		message = exchange.statusText;
	} else {
		try {
			message = getErrorMessage(JSON.parse(exchange.body)) ?? message;
		} catch {
			// Keep raw text fallback.
		}
	}
	return new SearchProviderError("tavily", `Tavily API error (${exchange.status}): ${message}`, exchange.status);
}

/** HTTP budget in seconds; the transport's own unit, derived from the pipeline's ms. */
function timeoutSecondsFromMs(timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
	return Math.max(1, Math.ceil(timeoutMs / 1000));
}

async function callTavilySearch(apiKey: string, params: TavilySearchParams): Promise<TavilySearchResult> {
	// A resolver may hand back the keyless marker or an empty string; neither may
	// reach the wire, and neither may fall through to the package's env lookup.
	const trimmed = apiKey.trim();
	if (!trimmed || trimmed === NO_AUTH_SENTINEL) throw new AIError.MissingApiKeyError(undefined, MISSING_KEY_MESSAGE);

	// The pipeline owns the hard timeout; the same signal cancels the injected fetch.
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const exchanges: TavilyHttpExchange[] = [];
	const clientParams = toClientSearchParams(params);
	clientParams.signal = signal;
	clientParams.timeoutSeconds = timeoutSecondsFromMs(params.timeoutMs);

	const client = createTavilyClient({
		apiKey: trimmed,
		// The vendor transport never forwards an AbortSignal to axios, so this
		// module always provides the adapter: the caller's `fetch` when given,
		// the global one otherwise. One path keeps `signal` cancelling the
		// socket and leaves the pipeline's hard timeout as the only authority.
		adapter: createFetchAdapter(params.fetch ?? fetch, signal, exchanges),
	});
	const result = await tavilySearch(client, clientParams);
	return settleTavilyResult(result, exchanges, signal);
}

/** Turn the verb's result-or-failure into data, or into the provider's error type. */
function settleTavilyResult(
	result: Awaited<ReturnType<typeof tavilySearch>>,
	exchanges: TavilyHttpExchange[],
	signal: AbortSignal,
): TavilySearchResult {
	if (result.ok) return result.data;
	const exchange = exchanges[exchanges.length - 1];
	if (exchange) throw toHttpError(exchange);
	if (signal.aborted) throw signal.reason;
	throw new SearchProviderError("tavily", `Tavily request failed: ${result.error.message}`);
}

function toSearchResponse(response: TavilySearchResult, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];

	for (const result of response.results) {
		if (!result.url) continue;
		const title = result.title || result.url;
		const snippet = result.content.length > 0 ? result.content : undefined;
		sources.push({
			title,
			url: result.url,
			snippet,
			publishedDate: result.publishedDate,
			ageSeconds: dateToAgeSeconds(result.publishedDate),
		});
	}

	const answer = response.answer?.trim() || undefined;
	return {
		provider: "tavily",
		answer,
		sources: sources.slice(0, numResults),
		requestId: response.requestId,
		authMode: "api_key",
	};
}

function hasRenderableResponse(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	return response.sources.length > 0;
}

/** Execute Tavily web search. */
export async function searchTavily(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const tavilyParams: TavilySearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	if (parsed.hasDirectives) {
		// Tavily prefers clean natural text; re-emit only phrases and -exclusions.
		tavilyParams.query = formatQuery(parsed, { phrases: true, negation: true });
		const include = siteHosts(parsed.sites);
		const exclude = siteHosts(parsed.excludedSites);
		if (include.length > 0) tavilyParams.include_domains = include;
		if (exclude.length > 0) tavilyParams.exclude_domains = exclude;
		if (parsed.after) tavilyParams.start_date = parsed.after;
		if (parsed.before) tavilyParams.end_date = parsed.before;
	}
	const keyOrResolver: ApiKey = params.authStorage.keys.resolver("tavily", {
		sessionId: params.sessionId,
	});

	const numResults = clampNumResults(tavilyParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const authOptions = {
		signal: params.signal,
		missingKeyMessage: MISSING_KEY_MESSAGE,
	};
	const callWithAuth = (searchParams: TavilySearchParams) =>
		withAuth(keyOrResolver, key => callTavilySearch(key, searchParams), authOptions);

	const response = toSearchResponse(await callWithAuth(tavilyParams), numResults);
	const hasTimeFilter = Boolean(tavilyParams.recency || tavilyParams.start_date || tavilyParams.end_date);
	if (!hasTimeFilter || hasRenderableResponse(response)) {
		return response;
	}

	// Time filters commonly zero out results; retry once without them.
	return toSearchResponse(
		await callWithAuth({ ...tavilyParams, recency: undefined, start_date: undefined, end_date: undefined }),
		numResults,
	);
}

/** Search provider for Tavily web search. */
export class TavilyProvider extends SearchProvider {
	readonly id = "tavily";
	readonly label = "Tavily";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("tavily") !== undefined || !!getEnvApiKey("tavily");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchTavily(params);
	}
}
