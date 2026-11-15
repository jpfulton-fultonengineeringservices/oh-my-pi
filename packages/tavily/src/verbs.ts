/**
 * The seven verbs.
 *
 * Each one builds its own request body, posts it through the client's
 * transport, and normalises the response, returning a {@link TavilyResult} —
 * none of them throws. Three rules hold across all of them:
 *
 * - **Keyless is enforced here.** `@tavily/core` puts the keyless restriction
 *   in `tavily()`, which this package does not call, so a keyless client
 *   reaching `crawl` would otherwise hit the network unauthenticated. Without
 *   a key only `search` and `extract` may go out; every other verb resolves to
 *   a `TavilyFailure` with code `auth` and issues no request.
 * - **An abort settles the call.** An already-aborted signal returns at once; a
 *   signal that fires mid-request resolves an `aborted` failure rather than
 *   leaving the caller awaiting a response that will never be used. The
 *   in-flight request is left to drain — the transport exposes no cancel hook.
 * - **Per-verb budgets are ours.** The transport's 60s default is overridden
 *   with the budgets the API actually needs (crawl and map routinely take
 *   minutes), and research keeps the transport's "no default timeout" rule
 *   unless the caller passes one.
 */

import type {
	TavilyClient,
	TavilyCrawlParams,
	TavilyCrawlResult,
	TavilyExtractParams,
	TavilyExtractResult,
	TavilyFailure,
	TavilyMapParams,
	TavilyMapResult,
	TavilyResearchChunk,
	TavilyResearchParams,
	TavilyResearchRecord,
	TavilyResearchStatusParams,
	TavilyResult,
	TavilySearchParams,
	TavilySearchResult,
} from "./types";
import { classifyTavilyError, tavilyAborted } from "./errors";
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
} from "./wire";

const SEARCH_ENDPOINT = "search";
const EXTRACT_ENDPOINT = "extract";
const CRAWL_ENDPOINT = "crawl";
const MAP_ENDPOINT = "map";
const RESEARCH_ENDPOINT = "research";

/** HTTP budget per verb; `undefined` means "whatever the transport defaults to". */
const VERB_TIMEOUT_SECONDS = {
	search: 60,
	extract: 30,
	crawl: 150,
	map: 150,
	research: undefined,
	researchStatus: 60,
} as const satisfies Record<string, number | undefined>;

/** The only verbs Tavily serves without an API key. */
const KEYLESS_CAPABLE: ReadonlySet<string> = new Set(["search", "extract"]);

/** Verbs that must be refused before a request is built. */
type GatedVerb = "crawl" | "map" | "research" | "getResearch";

const KEYLESS_UNSUPPORTED_HINT =
	"Set TAVILY_API_KEY (or pass apiKey) to use this verb, or use tavily_search / tavily_extract, which work keyless.";

/** Text fields a streaming research event may carry its report fragment in. */
const RESEARCH_TEXT_KEYS: ReadonlyArray<string> = ["content", "delta", "text", "output", "answer", "report"];

const SSE_DATA_PREFIX = "data:";
const SSE_DONE_SENTINEL = "[DONE]";

/** The refusal a gated verb returns when the client has no key. */
function keylessRefusal(client: TavilyClient, verb: GatedVerb): TavilyFailure | undefined {
	if (client.hasApiKey || KEYLESS_CAPABLE.has(verb)) return undefined;
	return {
		code: "auth",
		message: `Keyless mode only supports search and extract; ${verb} needs an API key. ${KEYLESS_UNSUPPORTED_HINT}`,
	};
}

function requestOptions(timeoutSeconds: number | undefined): { timeoutSeconds?: number } {
	return timeoutSeconds === undefined ? {} : { timeoutSeconds };
}

/** Settle one transport call into a result: normalise on success, classify on failure. */
async function settle<T>(
	work: () => Promise<unknown>,
	normalise: (raw: unknown) => T,
	signal: AbortSignal | undefined,
): Promise<TavilyResult<T>> {
	if (signal?.aborted) return { ok: false, error: tavilyAborted(signal) };
	const pending = work();
	if (signal === undefined) {
		try {
			return { ok: true, data: normalise(await pending) };
		} catch (error) {
			return { ok: false, error: classifyTavilyError(error) };
		}
	}

	const { promise, resolve, reject } = Promise.withResolvers<TavilyResult<T>>();
	let settled = false;
	const finish = (result: TavilyResult<T>): void => {
		if (settled) return;
		settled = true;
		resolve(result);
	};
	const onAbort = (): void => finish({ ok: false, error: tavilyAborted(signal) });
	signal.addEventListener("abort", onAbort, { once: true });
	pending.then(
		raw => {
			if (settled) return;
			settled = true;
			resolve({ ok: true, data: normalise(raw) });
		},
		error => {
			if (settled) return;
			settled = true;
			reject(error);
		},
	);
	return promise
		.then(
			result => result,
			error => ({ ok: false, error: classifyTavilyError(error) }) as TavilyResult<T>,
		)
		.finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
}

/** `POST /search`. `params.topic` is the one field never sent unless asked for. */
export function tavilySearch(
	client: TavilyClient,
	params: TavilySearchParams,
): Promise<TavilyResult<TavilySearchResult>> {
	return settle(
		() =>
			client.transport.post(
				SEARCH_ENDPOINT,
				buildSearchBody(params),
				requestOptions(params.timeoutSeconds ?? VERB_TIMEOUT_SECONDS.search),
			),
		normaliseSearch,
		params.signal,
	);
}

/** `POST /extract`. Keyless-capable, like search. */
export function tavilyExtract(
	client: TavilyClient,
	params: TavilyExtractParams,
): Promise<TavilyResult<TavilyExtractResult>> {
	return settle(
		() =>
			client.transport.post(
				EXTRACT_ENDPOINT,
				buildExtractBody(params),
				requestOptions(params.timeoutSeconds ?? VERB_TIMEOUT_SECONDS.extract),
			),
		normaliseExtract,
		params.signal,
	);
}

/** `POST /crawl`. Requires a key; see the module keyless rule. */
export function tavilyCrawl(client: TavilyClient, params: TavilyCrawlParams): Promise<TavilyResult<TavilyCrawlResult>> {
	const refusal = keylessRefusal(client, "crawl");
	if (refusal !== undefined) return Promise.resolve({ ok: false, error: refusal });
	return settle(
		() =>
			client.transport.post(
				CRAWL_ENDPOINT,
				buildCrawlBody(params),
				requestOptions(params.timeoutSeconds ?? VERB_TIMEOUT_SECONDS.crawl),
			),
		normaliseCrawl,
		params.signal,
	);
}

/** `POST /map`. Requires a key. */
export function tavilyMap(client: TavilyClient, params: TavilyMapParams): Promise<TavilyResult<TavilyMapResult>> {
	const refusal = keylessRefusal(client, "map");
	if (refusal !== undefined) return Promise.resolve({ ok: false, error: refusal });
	return settle(
		() =>
			client.transport.post(
				MAP_ENDPOINT,
				buildMapBody(params),
				requestOptions(params.timeoutSeconds ?? VERB_TIMEOUT_SECONDS.map),
			),
		normaliseMap,
		params.signal,
	);
}

/**
 * `POST /research`: submit a research job and get its record back. Poll the
 * job with {@link tavilyResearchStatus}. This endpoint has no server-side
 * timeout, so pass `timeoutSeconds` when the call must not wait indefinitely.
 */
export function tavilyResearch(
	client: TavilyClient,
	params: TavilyResearchParams,
): Promise<TavilyResult<TavilyResearchRecord>> {
	const refusal = keylessRefusal(client, "research");
	if (refusal !== undefined) return Promise.resolve({ ok: false, error: refusal });
	return settle(
		() =>
			client.transport.post(
				RESEARCH_ENDPOINT,
				buildResearchBody(params),
				requestOptions(params.timeoutSeconds ?? params.timeout ?? VERB_TIMEOUT_SECONDS.research),
			),
		normaliseResearchRecord,
		params.signal,
	);
}

/**
 * `GET /research/{id}`: read a research job's status and, once it has finished,
 * its report. Requires a key.
 */
export function tavilyResearchStatus(
	client: TavilyClient,
	params: TavilyResearchStatusParams,
): Promise<TavilyResult<TavilyResearchRecord>> {
	const refusal = keylessRefusal(client, "getResearch");
	if (refusal !== undefined) return Promise.resolve({ ok: false, error: refusal });
	const endpoint = `${RESEARCH_ENDPOINT}/${encodeURIComponent(params.requestId)}`;
	const query = buildResearchQueryParams(params);
	return settle(
		() =>
			client.transport.get(endpoint, {
				...requestOptions(params.timeoutSeconds ?? VERB_TIMEOUT_SECONDS.researchStatus),
				params: query,
			}),
		normaliseResearchRecord,
		params.signal,
	);
}

/** Turn one decoded line into a chunk, or drop it when it carries nothing. */
function researchChunkFromLine(line: string): TavilyResearchChunk | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	const payload = trimmed.startsWith(SSE_DATA_PREFIX) ? trimmed.slice(SSE_DATA_PREFIX.length).trim() : trimmed;
	if (payload.length === 0 || payload === SSE_DONE_SENTINEL) return undefined;

	if (!payload.startsWith("{") && !payload.startsWith("[")) return { text: payload };

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return { text: payload };
	}

	const record = normaliseResearchDelta(parsed);
	const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	let text = "";
	for (const key of RESEARCH_TEXT_KEYS) {
		const value = fields[key];
		if (typeof value === "string") {
			text = value;
			break;
		}
	}
	const hasRecord = Object.keys(record).length > 0;
	if (text.length === 0 && !hasRecord) return undefined;
	const chunk: TavilyResearchChunk = { text };
	if (hasRecord) chunk.record = record;
	return chunk;
}

/** Terminal chunk: the stream is over, and this is why. */
function failedChunk(error: TavilyFailure): TavilyResearchChunk {
	return { text: "", error };
}

/**
 * Await one pull from the byte generator, resolving `null` if the signal fires
 * first. The abandoned pull is harmless: the caller's `finally` closes the
 * generator, which destroys the underlying stream.
 */
async function raceAbort<T>(next: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
	if (signal === undefined) return next;
	if (signal.aborted) return null;
	const { promise, resolve, reject } = Promise.withResolvers<T | null>();
	let settled = false;
	const settleWith = (settle: () => void): void => {
		if (settled) return;
		settled = true;
		settle();
	};
	const onAbort = (): void => settleWith(() => resolve(null));
	signal.addEventListener("abort", onAbort, { once: true });
	next.then(
		value => settleWith(() => resolve(value)),
		error => settleWith(() => reject(error)),
	);
	return promise.finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

/** Decode bytes to text lines and emit one chunk per event that carries anything. */
async function* researchChunks(
	iterator: AsyncIterator<Buffer, void, unknown>,
	abort: AbortSignal | undefined,
): AsyncGenerator<TavilyResearchChunk> {
	const decoder = new TextDecoder("utf-8");
	let pending = "";
	try {
		for (;;) {
			if (abort?.aborted) {
				yield failedChunk(tavilyAborted(abort));
				return;
			}
			const next = await raceAbort(iterator.next(), abort);
			if (next === null) {
				yield failedChunk(tavilyAborted(abort));
				return;
			}
			if (next.done === true) break;
			pending += decoder.decode(next.value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const chunk = researchChunkFromLine(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				if (chunk !== undefined) yield chunk;
				newline = pending.indexOf("\n");
			}
		}
		const chunk = researchChunkFromLine(pending + decoder.decode());
		if (chunk !== undefined) yield chunk;
	} catch (error) {
		yield failedChunk(classifyTavilyError(error));
	} finally {
		// Best-effort cleanup. Closing a stream that is already dying can itself
		// reject, and that must not replace the terminal chunk the caller is
		// receiving or turn a resolved call into a thrown one.
		try {
			await iterator.return?.();
		} catch {
			// The caller already has its result; there is nothing left to report.
		}
	}
}

/**
 * `POST /research` with `stream: true`: the report as it is written.
 *
 * The transport hands back a `Buffer` generator of the raw body, so this is
 * where those bytes become text: decoded with a streaming `TextDecoder` (a
 * multibyte character split across chunks stays intact), split on line
 * boundaries with the partial tail carried over, SSE `data:` prefixes stripped,
 * JSON events parsed into {@link TavilyResearchChunk.record} with their report
 * fragment surfaced as `text`. Raw buffers never reach the caller.
 *
 * Like every other verb it does not throw: a failure — keyless, transport, or
 * abort — arrives as a terminal chunk carrying `error`, after which no further
 * chunk is produced.
 */
export async function* tavilyResearchStream(
	client: TavilyClient,
	params: TavilyResearchParams,
	signal?: AbortSignal,
): AsyncGenerator<TavilyResearchChunk> {
	const refusal = keylessRefusal(client, "research");
	if (refusal !== undefined) {
		yield failedChunk(refusal);
		return;
	}
	const abort = signal ?? params.signal;
	if (abort?.aborted) {
		yield failedChunk(tavilyAborted(abort));
		return;
	}

	let iterator: AsyncIterator<Buffer, void, unknown>;
	try {
		const generator = await client.transport.stream(
			RESEARCH_ENDPOINT,
			buildResearchBody({ ...params, stream: true }),
			requestOptions(params.timeoutSeconds ?? params.timeout ?? VERB_TIMEOUT_SECONDS.research),
		);
		iterator = generator[Symbol.asyncIterator]();
	} catch (error) {
		yield failedChunk(classifyTavilyError(error));
		return;
	}

	yield* researchChunks(iterator, abort);
}
