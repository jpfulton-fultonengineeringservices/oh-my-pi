/**
 * Thin HTTP client for the memvid-kb-rs knowledge service.
 *
 * This is deliberately a second implementation of a contract that also lives in the
 * config repo's `extensions/lib/knowledge/client.ts`: an omp extension compiles
 * against the published `@oh-my-pi/pi-coding-agent`, which resolves no fork-only
 * module, so the two can never share code (documented at
 * `extensions/lib/knowledge/config.ts:1-38`). What they share is the wire contract —
 * routes, methods, canonical camelCase field spellings, and the
 * `knowledge_unreachable:` / `knowledge_unavailable:` split — mirrored here rather
 * than invented.
 *
 * Only the routes this backend needs are wrapped: `POST /memories/{id}/find`,
 * `POST /memories/{id}/records`, `GET /memories/{id}/records`, `GET /healthz`. The
 * rest of the verb set (create, ask, enrich, supersede, verify, track metadata) is
 * the tool layer's surface and stays there.
 *
 * Nothing here retries, queues, or journals. A read this client cannot honour is a
 * prefixed failure with a non-empty message, never an empty result set; a write that
 * cannot be completed is refused, never reported as centrally stored.
 */

import { asRecord, sanitizeText, stringProperty, truncate } from "@oh-my-pi/pi-utils";
import { normalizeBearer } from "./bearer";
import {
	FIND_MODES,
	FIND_PAGE,
	FIND_RESULT,
	RECORD_LIST_ITEM,
	RECORD_PAGE,
	REMEMBER_RESPONSE,
	type FieldShape,
	type FindMode,
	type FindResponse,
	type HealthReport,
	type RecordListing,
	type RememberResponse,
	type Shaped,
} from "./dto";
import { KNOWLEDGE_ERROR_PREFIX, redactToken } from "./errors";
import { withTimeoutSignal } from "../utils/fetch-timeout";

/** A knowledge call must finish well inside a tool turn; a wedged service must not wedge the agent. */
export const HTTP_TIMEOUT_MS = 15_000;

/**
 * A liveness probe gets its own, shorter budget: `/memory status` and the settings UI
 * render straight from `health()`, so a wedged service must not stall them for the full
 * call timeout. Same reasoning the fork's own knowledge reader applies at 10s.
 */
export const HEALTH_TIMEOUT_MS = 5_000;

/** Identifies this client to the service for observability. */
const USER_AGENT = "omp-memvidkb-backend";

/** Upper bound on echoed service diagnostics, so a failure stays readable and bounded. */
const MAX_DETAIL_CHARS = 400;

/**
 * Where to call and with what bearer — the whole of what the transport needs.
 *
 * `tokenEnvVar` travels with the value so a refusal can name the variable an operator has
 * to fix; the value itself is never included in a returned string.
 */
export type MemvidkbEndpoint = {
	readonly baseUrl: string;
	readonly tokenEnvVar: string;
	readonly token: string;
};

/** One request against the knowledge service. */
export type MemvidkbRequest = {
	readonly method: "GET" | "POST";
	/** Path under the base URL with segments already encoded, e.g. `/memories/dev/find`. */
	readonly path: string;
	/** JSON body for POST requests; omitted for GET. */
	readonly body?: unknown;
	/** What is being authorized, e.g. `find on track "dev"`. */
	readonly subject: string;
	/** True when the call mutates central state, so outage wording stays honest. */
	readonly write?: boolean;
};

/** One call's outcome: the value the service reported, or a prefixed failure. */
export type MemvidkbOutcome<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: string };

/** A service success body, once its JSON envelope is checked. */
export type MemvidkbBody = Record<string, unknown>;

/** A response this client cannot honour, carrying exactly one prefix. */
export type MemvidkbRefusal = { readonly ok: false; readonly error: string };

/** One shape's parse outcome: the typed value, or the refusal naming the fault. */
export type MemvidkbParsed<T> = { readonly ok: true; readonly value: T } | MemvidkbRefusal;

// One request's transport outcome: the status and body of a 2xx, or the already-prefixed
// failure. The JSON and text entries below differ only in how they read that body, so
// status mapping, bearer scrubbing, and the outage tails each exist in exactly one place.
type RawOutcome = { readonly ok: true; readonly status: number; readonly raw: string } | MemvidkbRefusal;

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false };
	}
}

// Redact runs *before* the clip: clipping first can cut a bearer in half, and the head of
// a bearer left behind by such a cut is still a leak. `sanitizeText` then strips ANSI and
// control characters, because every caller hands the result to the model.
function clipDetail(text: string, token: string): string {
	const scrubbed = redactToken(text, token);
	return sanitizeText(truncate(scrubbed, MAX_DETAIL_CHARS));
}

// Renders the service's `{"error":{"code","message"}}` envelope, or clipped raw text,
// with the bearer scrubbed out and every control character stripped: this is
// service-controlled text destined for the model.
function describeBody(raw: string, token: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "(empty response body)";
	let detail = trimmed;
	const parsed = parseJson(trimmed);
	const envelope = parsed.ok ? asRecord(parsed.value) : null;
	if (envelope) {
		const body = asRecord(envelope.error);
		if (body) {
			const code = stringProperty(body, "code");
			const message = stringProperty(body, "message");
			if (code && message) detail = `${code}: ${message}`;
			else detail = message ?? code ?? trimmed;
		} else {
			detail = stringProperty(envelope, "error") ?? trimmed;
		}
	}
	return clipDetail(detail, token);
}

// Outage honesty: an unreachable read is never an empty answer, and an unreachable write
// is never a stored one.
function outageTail(write: boolean | undefined): string {
	return write
		? " Nothing was stored, queued, or retried locally: this backend rejects a write while the service is unavailable rather than reporting it as centrally saved."
		: " This is a retrieval outage, not a zero-result answer.";
}

function statusFailure(
	endpoint: MemvidkbEndpoint,
	request: MemvidkbRequest,
	subject: string,
	status: number,
	detail: string,
): string {
	const where = `${request.method} ${request.path} for ${subject} against ${endpoint.baseUrl}`;
	if (status === 401) {
		return `${KNOWLEDGE_ERROR_PREFIX.unauthorized}${where} was refused by the service (401 unauthorized): ${detail}`;
	}
	if (status === 403) {
		return (
			`${KNOWLEDGE_ERROR_PREFIX.forbidden}${where} was denied by service policy (403 forbidden): ${detail}. ` +
			"The request was not dropped, downgraded, or retried against another track."
		);
	}
	if (status === 404) {
		return `${KNOWLEDGE_ERROR_PREFIX.notFound}${where} matched no resource this context may see (404 not_found): ${detail}`;
	}
	if (status === 400) {
		return `${KNOWLEDGE_ERROR_PREFIX.unavailable}${where} was rejected as invalid (400 validation): ${detail}`;
	}
	if (status === 409) {
		return (
			`${KNOWLEDGE_ERROR_PREFIX.unavailable}${where} was refused because the target is locked or ` +
			`already carries a successor (409 file_locked): ${detail}`
		);
	}
	if (status === 429 || status >= 500) {
		return `${KNOWLEDGE_ERROR_PREFIX.unreachable}${where} failed with HTTP ${String(status)}: ${detail}.${outageTail(request.write)}`;
	}
	return `${KNOWLEDGE_ERROR_PREFIX.unavailable}${where} returned HTTP ${String(status)}: ${detail}`;
}

/**
 * Send one bearer-authenticated request and report its transport outcome.
 *
 * Transport failures, timeouts, 429 and 5xx map to `knowledge_unreachable:`;
 * 401/403/404 to their own prefixes. The bearer is never included in a returned
 * string. Nothing here interprets the body: the service answers some routes in JSON
 * and `healthz` in plain text.
 */
async function performCall(
	endpoint: MemvidkbEndpoint,
	request: MemvidkbRequest,
	signal?: AbortSignal,
	timeoutMs: number = HTTP_TIMEOUT_MS,
): Promise<RawOutcome> {
	signal?.throwIfAborted();
	const subject = request.subject;
	// The bearer is normalised here, at the socket, not at config load: both `.memvidkb`
	// readers accept a whitespace-only value (the accept/reject line the deployed reader
	// pins), so nothing may reach `fetch` without something sendable to put in the header.
	const bearer = normalizeBearer(endpoint);
	if (!bearer.ok) return bearer;
	let response: Response;
	try {
		response = await fetch(`${endpoint.baseUrl}${request.path}`, {
			method: request.method,
			headers: {
				authorization: `Bearer ${bearer.value}`,
				"content-type": "application/json",
				"user-agent": USER_AGENT,
			},
			// `JSON.stringify` drops the `undefined` fields, so an option the caller left
			// unset stays off the wire and the service's own documented default applies.
			body: request.body === undefined ? undefined : JSON.stringify(request.body),
			signal: withTimeoutSignal(timeoutMs, signal),
		});
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.unreachable}${request.method} ${request.path} for ${subject} could not reach the knowledge service at ${endpoint.baseUrl}: ${reason}.${outageTail(request.write)}`,
		};
	}

	const raw = await response.text();
	if (!response.ok) {
		return {
			ok: false,
			// Scrub with the bearer that actually went out, so a service echoing it back is
			// redacted even when the env value carried padding.
			error: statusFailure(endpoint, request, subject, response.status, describeBody(raw, bearer.value)),
		};
	}
	return { ok: true, status: response.status, raw };
}

/**
 * Perform one bearer-authenticated JSON call.
 *
 * A 2xx whose body is not JSON, or is JSON but not an object, is reported
 * `knowledge_unavailable:` — never as an empty success, which a caller could not
 * distinguish from a service that legitimately had nothing.
 */
async function callJson(
	endpoint: MemvidkbEndpoint,
	request: MemvidkbRequest,
	signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly body: MemvidkbBody } | MemvidkbRefusal> {
	const outcome = await performCall(endpoint, request, signal);
	if (!outcome.ok) return outcome;
	const parsed = parseJson(outcome.raw);
	if (!parsed.ok) {
		const scrub = endpoint.token.trim();
		const detail = outcome.raw.trim() ? clipDetail(outcome.raw.trim(), scrub) : "(empty response body)";
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.unavailable}${request.method} ${request.path} for ${request.subject} returned a body that is not JSON (HTTP ${String(outcome.status)}): ${detail}. Refusing to report an unreadable success.`,
		};
	}
	const body = asRecord(parsed.value);
	// `null`, an array, or a bare scalar is the shape no DTO here deserializes: read as a
	// refusal, because an empty object would hand the caller zero counts and empty arrays.
	if (body === null) {
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.unavailable}${request.method} ${request.path} for ${request.subject} returned a success body that is not a JSON object (HTTP ${String(outcome.status)}). Refusing to report an unreadable success.`,
		};
	}
	return { ok: true, body };
}

/**
 * Refuse a response the service did not send in the documented form.
 *
 * @param verb - Human name of the operation, for the failure message.
 * @param reason - What about the body made it unreadable.
 * @returns The prefixed refusal, never a padded default.
 */
export function refuseResponse(verb: string, reason: string): MemvidkbRefusal {
	return {
		ok: false,
		error: `${KNOWLEDGE_ERROR_PREFIX.unavailable}${verb} received a response this client cannot honour: ${reason}`,
	};
}

/**
 * Refuse a request this client would have sent wrong, before it reaches the wire.
 *
 * @param verb - Human name of the operation, for the failure message.
 * @param reason - What about the arguments made the request unworthy of the wire.
 * @returns The prefixed refusal, distinguishable from a service outage.
 */
export function refuseRequest(verb: string, reason: string): MemvidkbRefusal {
	return {
		ok: false,
		error: `${KNOWLEDGE_ERROR_PREFIX.unavailable}${verb} refused the request before sending it: ${reason}`,
	};
}

/**
 * Trim a required argument, refusing the call rather than sending an empty one.
 *
 * @param verb - Human name of the operation, for the failure message.
 * @param field - The argument's name as the caller knows it.
 * @param value - The supplied value.
 * @returns The trimmed value, or the refusal that stopped the request.
 */
export function requiredText(verb: string, field: string, value: string): MemvidkbParsed<string> {
	const trimmed = value.trim();
	if (trimmed.length === 0) return refuseRequest(verb, `${field} was empty; nothing was sent`);
	return { ok: true, value: trimmed };
}

/**
 * Accept an optional enum only if the service documents it.
 *
 * @param verb - Human name of the operation, for the failure message.
 * @param field - The argument's name as the caller knows it.
 * @param value - The supplied value, or `undefined` to leave it to the service.
 * @param allowed - The values the service deserializes.
 * @returns The value, nothing, or the refusal listing what is accepted.
 */
export function allowedValue<T extends string>(
	verb: string,
	field: string,
	value: T | undefined,
	allowed: readonly T[],
): MemvidkbParsed<T | undefined> {
	if (value === undefined) return { ok: true, value: undefined };
	if ((allowed as readonly string[]).includes(value)) return { ok: true, value };
	return refuseRequest(
		verb,
		`${field} "${value}" is not one of the values the service accepts (${allowed.join(", ")})`,
	);
}

// Each field is checked against what the DTO says it must be, and the first failure
// becomes the report: `results (expected an array of objects) was missing from the
// response` is actionable where a bare "malformed response" would not be.
function reader(verb: string): {
	str(body: MemvidkbBody, key: string): string;
	num(body: MemvidkbBody, key: string): number;
	strs(body: MemvidkbBody, key: string): string[];
	rows(body: MemvidkbBody, key: string): MemvidkbBody[];
	fail(): MemvidkbRefusal | null;
} {
	let fault: string | undefined;
	const mark = (key: string, expected: string): void => {
		fault ??= `${key} (expected ${expected})`;
	};
	return {
		str(body, key) {
			const value = body[key];
			if (typeof value !== "string") {
				mark(key, "a string");
				return "";
			}
			return value;
		},
		num(body, key) {
			const value = body[key];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				mark(key, "a number");
				return 0;
			}
			return value;
		},
		strs(body, key) {
			const value = body[key];
			if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
				mark(key, "an array of strings");
				return [];
			}
			return [...value];
		},
		rows(body, key) {
			const value = body[key];
			if (!Array.isArray(value) || !value.every(item => asRecord(item) !== null)) {
				mark(key, "an array of objects");
				return [];
			}
			return value as MemvidkbBody[];
		},
		fail() {
			return fault === undefined ? null : refuseResponse(verb, `${fault} was missing from the response`);
		},
	};
}

// Every documented optional serializes as JSON `null` rather than being omitted, so
// `null` and an absent key mean the same thing here: nothing recorded.
function optString(body: MemvidkbBody, key: string): string | null {
	const value = body[key];
	return typeof value === "string" ? value : null;
}

function optNumber(body: MemvidkbBody, key: string): number | null {
	const value = body[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read one documented response object into the type its shape describes.
 *
 * @param verb - Human name of the operation, for the failure message.
 * @param body - The decoded success body.
 * @param spec - Field names and the wire type each one documents.
 * @returns The typed value, or the refusal naming the first unreadable field.
 */
export function readShape<S extends FieldShape>(verb: string, body: MemvidkbBody, spec: S): MemvidkbParsed<Shaped<S>> {
	const read = reader(verb);
	const value: MemvidkbBody = {};
	for (const [key, kind] of Object.entries(spec)) {
		switch (kind) {
			case "string":
				value[key] = read.str(body, key);
				break;
			case "number":
				value[key] = read.num(body, key);
				break;
			case "strings":
				value[key] = read.strs(body, key);
				break;
			case "optstring":
				value[key] = optString(body, key);
				break;
			case "optnumber":
				value[key] = optNumber(body, key);
				break;
		}
	}
	return read.fail() ?? { ok: true, value: value as Shaped<S> };
}

/**
 * Read one documented array field, row by row, refusing the whole read on the first row
 * the shape does not accept.
 *
 * @param verb - Human name of the operation, for the failure message.
 * @param body - The decoded success body.
 * @param key - The array field's documented name.
 * @param parse - Reads one row.
 * @returns The rows, or the refusal from the array or from a row.
 */
export function readRows<T>(
	verb: string,
	body: MemvidkbBody,
	key: string,
	parse: (row: MemvidkbBody) => MemvidkbParsed<T>,
): MemvidkbParsed<readonly T[]> {
	const read = reader(verb);
	const rows = read.rows(body, key);
	const fault = read.fail();
	if (fault !== null) return fault;
	const out: T[] = [];
	for (const row of rows) {
		const parsed = parse(row);
		if (!parsed.ok) return parsed;
		out.push(parsed.value);
	}
	return { ok: true, value: out };
}

// One JSON call whose body is then read into a documented shape; both verbs below are
// this plus their own field names.
async function callJsonParsed<T>(
	endpoint: MemvidkbEndpoint,
	request: MemvidkbRequest,
	signal: AbortSignal | undefined,
	parse: (body: MemvidkbBody) => MemvidkbParsed<T>,
): Promise<MemvidkbOutcome<T>> {
	const call = await callJson(endpoint, request, signal);
	if (!call.ok) return { ok: false, error: call.error };
	const parsed = parse(call.body);
	return parsed.ok ? { ok: true, data: parsed.value } : { ok: false, error: parsed.error };
}

function trackPath(track: string, suffix: string): string {
	return `/memories/${encodeURIComponent(track)}${suffix}`;
}

/** Options for one find call; omitted options stay off the wire. */
export type FindOptions = {
	/** Page size; omitted means the service's documented default (10). */
	readonly limit?: number;
	/** Page offset; omitted means 0. */
	readonly offset?: number;
	/** Retrieval mode; omitted means the service's documented default (`lexical`). */
	readonly mode?: FindMode;
};

/**
 * Search one track (`POST /memories/{id}/find`).
 *
 * @param endpoint - Service origin and bearer.
 * @param track - Track to search; must be one this context may read.
 * @param query - Text to retrieve on.
 * @param options - Paging and retrieval mode; unset options keep the service's defaults.
 * @param signal - Caller cancellation.
 * @returns The page, or a prefixed failure; an outage is never an empty page.
 */
export async function findTrack(
	endpoint: MemvidkbEndpoint,
	track: string,
	query: string,
	options?: FindOptions,
	signal?: AbortSignal,
): Promise<MemvidkbOutcome<FindResponse>> {
	const verb = "find";
	const resolvedTrack = requiredText(verb, "track", track);
	if (!resolvedTrack.ok) return { ok: false, error: resolvedTrack.error };
	const resolvedQuery = requiredText(verb, "query", query);
	if (!resolvedQuery.ok) return { ok: false, error: resolvedQuery.error };
	const mode = allowedValue(verb, "mode", options?.mode, FIND_MODES);
	if (!mode.ok) return { ok: false, error: mode.error };
	const path = trackPath(resolvedTrack.value, "/find");
	return callJsonParsed(
		endpoint,
		{
			method: "POST",
			path,
			body: { query: resolvedQuery.value, limit: options?.limit, offset: options?.offset, mode: mode.value },
			subject: `find on track "${resolvedTrack.value}"`,
		},
		signal,
		body => {
			const page = readShape(verb, body, FIND_PAGE);
			if (!page.ok) return page;
			const results = readRows(verb, body, "results", row => readShape(verb, row, FIND_RESULT));
			return results.ok ? { ok: true, value: { ...page.value, results: results.value } } : results;
		},
	);
}

/**
 * Store one record (`POST /memories/{track}/records`).
 *
 * `originActor` is required by the route and never derived from the bearer, so the
 * caller names the producer explicitly.
 *
 * @param endpoint - Service origin and bearer.
 * @param args - Track, text, producing actor, and any documented optionals.
 * @param signal - Caller cancellation.
 * @returns What the service stored, or a prefixed failure; a failure stores nothing.
 */
export async function rememberRecord(
	endpoint: MemvidkbEndpoint,
	args: {
		readonly track: string;
		readonly content: string;
		readonly originActor: string;
		readonly title?: string;
		readonly tags?: readonly string[];
	},
	signal?: AbortSignal,
): Promise<MemvidkbOutcome<RememberResponse>> {
	const verb = "remember";
	const track = requiredText(verb, "track", args.track);
	if (!track.ok) return { ok: false, error: track.error };
	const content = requiredText(verb, "content", args.content);
	if (!content.ok) return { ok: false, error: content.error };
	const originActor = requiredText(verb, "originActor", args.originActor);
	if (!originActor.ok) return { ok: false, error: originActor.error };
	const tags = args.tags?.map(tag => tag.trim()).filter(tag => tag.length > 0);
	const path = trackPath(track.value, "/records");
	return callJsonParsed(
		endpoint,
		{
			method: "POST",
			path,
			body: {
				content: content.value,
				originActor: originActor.value,
				title: args.title?.trim() || undefined,
				tags: tags && tags.length > 0 ? tags : undefined,
			},
			subject: `remember into track "${track.value}"`,
			write: true,
		},
		signal,
		body => readShape(verb, body, REMEMBER_RESPONSE),
	);
}

/**
 * List a track's records, bounded and paged, without their full text
 * (`GET /memories/{track}/records`).
 *
 * @param endpoint - Service origin and bearer.
 * @param args - Track plus optional `limit`/`offset`; omitted paging stays off the wire.
 * @param signal - Caller cancellation.
 * @returns The page, or a prefixed failure; an outage is never an empty listing.
 */
export async function listRecords(
	endpoint: MemvidkbEndpoint,
	args: { readonly track: string; readonly limit?: number; readonly offset?: number },
	signal?: AbortSignal,
): Promise<MemvidkbOutcome<RecordListing>> {
	const verb = "record listing";
	const track = requiredText(verb, "track", args.track);
	if (!track.ok) return { ok: false, error: track.error };
	const params = new URLSearchParams();
	if (args.limit !== undefined) params.set("limit", String(args.limit));
	if (args.offset !== undefined) params.set("offset", String(args.offset));
	const query = params.toString();
	const path = `${trackPath(track.value, "/records")}${query.length > 0 ? `?${query}` : ""}`;
	return callJsonParsed(
		endpoint,
		{ method: "GET", path, subject: `record listing for track "${track.value}"` },
		signal,
		body => {
			const page = readShape(verb, body, RECORD_PAGE);
			if (!page.ok) return page;
			// The wire name is `results`; the typed field says what those rows are.
			const records = readRows(verb, body, "results", row => readShape(verb, row, RECORD_LIST_ITEM));
			return records.ok ? { ok: true, value: { ...page.value, records: records.value } } : records;
		},
	);
}

/**
 * Ask the service whether it is up (`GET /healthz`).
 *
 * The handler answers `ok` as `text/plain` (`src/api.rs:152-154`), so this is the one
 * verb that must not be read as JSON: the JSON transport would call that body
 * unreadable. The text is the service's own word, sanitized and passed through rather
 * than paraphrased into a boolean the endpoint never reported.
 *
 * @param endpoint - Service origin and bearer.
 * @param signal - Caller cancellation.
 * @param timeoutMs - Probe budget; defaults to {@link HEALTH_TIMEOUT_MS}, well under the
 *   call timeout, because status surfaces block on this answer.
 * @returns The health text, or a prefixed failure naming the outage.
 */
export async function health(
	endpoint: MemvidkbEndpoint,
	signal?: AbortSignal,
	timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<MemvidkbOutcome<HealthReport>> {
	const request: MemvidkbRequest = { method: "GET", path: "/healthz", subject: "service health" };
	const outcome = await performCall(endpoint, request, signal, timeoutMs);
	if (!outcome.ok) return { ok: false, error: outcome.error };
	const text = outcome.raw.trim();
	if (!text) {
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.unavailable}GET ${request.path} for ${request.subject} returned an empty body (HTTP ${String(outcome.status)}). Refusing to report an empty success.`,
		};
	}
	return { ok: true, data: { reachable: true, body: sanitizeText(text) } };
}
