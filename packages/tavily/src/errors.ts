/**
 * Failure typing for `@oh-my-pi/pi-tavily`.
 *
 * The verbs never throw: every error path is funnelled through
 * {@link classifyTavilyError} and returned as a `TavilyFailure`. The
 * classification is the contract the agent-facing tools render from, so it
 * covers each shape the transport can produce: `TavilyRequestError` with a
 * status, the keyless-limit envelope, the transport's timeout `Error`, and an
 * aborted `AbortSignal`. A value that is none of those is still classified: an
 * object advertising an HTTP status keeps that status's code, and anything
 * genuinely unidentifiable is `unknown` rather than a transport error.
 */

import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import type { TavilyErrorCode, TavilyFailure } from "./types";

/** Hard cap on `TavilyFailure.detail`, so a hostile body cannot bloat a tool result. */
export const TAVILY_DETAIL_MAX_CHARS = 2000;

/** HTTP statuses the API uses for each failure code; anything else is `transport`. */
const STATUS_CODES: Readonly<Record<number, TavilyErrorCode>> = {
	400: "bad-request",
	401: "auth",
	403: "auth",
	422: "bad-request",
	// 429 is the documented rate/cap status; 432 appears in none of the vendor's
	// tables, so it gets its own code rather than borrowing the 429 meaning.
	429: "rate-limit",
	432: "plan-limit",
};

/** Prefix of the timeout `Error` the transport raises for an `ECONNABORTED` axios failure. */
const TIMEOUT_MESSAGE_PREFIX = "Request timed out after";

/** An error carrying `code: "aborted"`: our own sentinel, axios' cancellation, or a DOM AbortError. */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(["AbortError", "CanceledError"]);

function bound(text: string): string {
	return text.length > TAVILY_DETAIL_MAX_CHARS ? `${text.slice(0, TAVILY_DETAIL_MAX_CHARS)}…` : text;
}

/** JSON text for a response body, or `undefined` when there is nothing to show. */
function describeBody(body: unknown): string | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body.length > 0 ? bound(body) : undefined;
	try {
		const json = JSON.stringify(body);
		return json === undefined ? undefined : bound(json);
	} catch {
		return bound(String(body));
	}
}

function messageOf(err: unknown): string | undefined {
	if (err instanceof Error) {
		const trimmed = err.message.trim();
		return trimmed.length > 0 ? bound(trimmed) : undefined;
	}
	if (typeof err === "string") {
		const trimmed = err.trim();
		return trimmed.length > 0 ? bound(trimmed) : undefined;
	}
	return undefined;
}

/** True when the error is an abort: a DOM `AbortError`, axios' `CanceledError`, or our sentinel. */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && ABORT_ERROR_NAMES.has(err.name);
}

/**
 * An HTTP status on a value that is not one of the vendor's error classes.
 *
 * The vendor always throws `TavilyRequestError` or `TavilyKeylessLimitError`,
 * which carry `status` and `body` unconditionally; those classes are the
 * authoritative signal and are tested first. This is the last-resort reading
 * for a failure that reached us as plain data — a rehydrated ledger row or a
 * hand-built object — where an advertised status is worth honouring.
 */
function foreignHttpStatus(err: unknown): number | undefined {
	if (err === null || typeof err !== "object" || err instanceof Error) return undefined;
	const status = (err as { status?: unknown }).status;
	return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/** A failure from a duck-typed status, keeping whatever body the value carries. */
function foreignFailure(err: unknown, status: number): TavilyFailure {
	const record = err as { body?: unknown; message?: unknown };
	const failure: TavilyFailure = {
		code: STATUS_CODES[status] ?? "transport",
		message: messageOf(record.message) ?? `${status} Error`,
		status,
	};
	const detail = describeBody(record.body ?? err);
	if (detail !== undefined) failure.detail = detail;
	return failure;
}

/** A failure for a signal that was already, or just became, aborted. */
export function tavilyAborted(signal?: AbortSignal): TavilyFailure {
	const reason = signal?.aborted ? signal.reason : undefined;
	const message =
		messageOf(reason) ??
		(typeof reason === "string" ? reason : undefined) ??
		"The request was aborted before it completed.";
	return { code: "aborted", message: bound(message) };
}

/**
 * An error view of a `TavilyFailure`, for callers that want to throw (a tool
 * that decides a failure is fatal) and for `instanceof`-style tests. Verbs
 * themselves return failures instead of throwing this.
 */
export class TavilyError extends Error {
	readonly code: TavilyErrorCode;
	readonly status?: number;
	readonly detail?: string;

	constructor(failure: TavilyFailure) {
		super(failure.message);
		this.name = "TavilyError";
		this.code = failure.code;
		if (failure.status !== undefined) this.status = failure.status;
		if (failure.detail !== undefined) this.detail = failure.detail;

		Object.setPrototypeOf(this, TavilyError.prototype);
	}

	/** The same information back as data, for the verbs' return channel. */
	toFailure(): TavilyFailure {
		const failure: TavilyFailure = { code: this.code, message: this.message };
		if (this.status !== undefined) failure.status = this.status;
		if (this.detail !== undefined) failure.detail = this.detail;
		return failure;
	}

	/** Classify anything — including another `TavilyError` — into a throwable. */
	static from(err: unknown): TavilyError {
		return new TavilyError(classifyTavilyError(err));
	}
}

/**
 * Map any thrown value onto a {@link TavilyFailure}, preserving the HTTP status
 * and a bounded `detail`.
 *
 * | input | code |
 * |---|---|
 * | `TavilyKeylessLimitError` | `keyless-limit` |
 * | `TavilyRequestError` 401/403 | `auth` |
 * | `TavilyRequestError` 429 | `rate-limit` |
 * | `TavilyRequestError` 432 | `plan-limit` |
 * | `TavilyRequestError` 400/422 | `bad-request` |
 * | `TavilyRequestError` other status | `transport` |
 * | `Error("Request timed out after …")` | `timeout` |
 * | `AbortError` / `CanceledError` | `aborted` |
 * | object with a numeric `status` | that status's code, else `transport` |
 * | anything else | `unknown` |
 */
export function classifyTavilyError(err: unknown): TavilyFailure {
	if (err instanceof TavilyError) return err.toFailure();

	// The cap class is a subclass of the request class, so it has to be tested
	// first: checking the parent first would report every cap as a generic
	// request error and lose the code, the retry window and the bonus hint.
	if (err instanceof TavilyKeylessLimitError) {
		return withStatus(err, "keyless-limit", keylessDetail(err));
	}

	if (err instanceof TavilyRequestError) {
		const code = STATUS_CODES[err.status] ?? "transport";
		return withStatus(err, code, describeBody(err.body) ?? messageOf(err));
	}

	if (isAbortError(err)) {
		return { code: "aborted", message: messageOf(err) ?? "The request was aborted." };
	}

	if (err instanceof Error && err.message.trim().startsWith(TIMEOUT_MESSAGE_PREFIX)) {
		return { code: "timeout", message: bound(err.message.trim()) };
	}

	const status = foreignHttpStatus(err);
	if (status !== undefined) return foreignFailure(err, status);

	const message = messageOf(err) ?? `Tavily request failed: ${String(err)}`;
	const code: TavilyErrorCode = err instanceof Error ? "transport" : "unknown";
	return { code, message, detail: describeBody(err instanceof Error ? undefined : err) };
}

function withStatus(err: TavilyRequestError, code: TavilyErrorCode, detail: string | undefined): TavilyFailure {
	const failure: TavilyFailure = { code, message: messageOf(err) ?? `${err.status} Error`, status: err.status };
	if (detail !== undefined) failure.detail = bound(detail);
	return failure;
}

/** The envelope's own words, plus the cap type, so a UI can explain the limit. */
function keylessDetail(err: TavilyKeylessLimitError): string | undefined {
	const parts = [describeBody(err.body) ?? err.message, `cap=${err.capType}`];
	if (err.retryAfter !== null) parts.push(`retryAfter=${err.retryAfter}s`);
	if (err.bonusEligible) parts.push("bonusEligible=true");
	return bound(parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" "));
}
