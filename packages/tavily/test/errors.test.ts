/**
 * Failure classification — the contract every agent-facing tool renders from.
 *
 * The verbs never throw, so what matters is that each shape the transport can
 * produce lands on the right code, keeps its HTTP status, and carries a `detail`
 * that is useful but bounded: a 5 MB error body must not become a tool result.
 */

import { describe, expect, it } from "bun:test";
import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import { TAVILY_DETAIL_MAX_CHARS, TavilyError, classifyTavilyError, tavilyAborted } from "../src/index";
import type { TavilyFailure, TavilyErrorCode } from "../src/index";

function requestError(status: number, body: unknown, message = ""): TavilyRequestError {
	return new TavilyRequestError({ message, status, body });
}

function keylessError(
	options: { capType?: string; retryAfter?: number | null; bonusEligible?: boolean; status?: number } = {},
): TavilyKeylessLimitError {
	const capType = options.capType ?? "hourly_keyless_limit";
	return new TavilyKeylessLimitError({
		message: "Hourly keyless limit reached",
		status: options.status ?? 429,
		body: { error: { code: capType, next_actions: [] } },
		capType,
		// `?? 900` would swallow an explicit null, and null is the case under test.
		retryAfter: options.retryAfter === undefined ? 900 : options.retryAfter,
		bonusEligible: options.bonusEligible ?? false,
		continuationPaths: [],
	});
}

describe("classifyTavilyError", () => {
	it("maps each documented status onto its code, keeping the status", () => {
		const table: ReadonlyArray<readonly [number, TavilyErrorCode]> = [
			[400, "bad-request"],
			[401, "auth"],
			[403, "auth"],
			[422, "bad-request"],
			[429, "rate-limit"],
			[432, "plan-limit"],
			[500, "transport"],
			[418, "transport"],
		];
		for (const [status, code] of table) {
			const failure = classifyTavilyError(requestError(status, { detail: "nope" }));
			expect(failure.code).toBe(code);
			expect(failure.status).toBe(status);
		}
	});

	it("keeps the response body as detail and falls back to a synthesised message", () => {
		const withBody = classifyTavilyError(requestError(400, { detail: { error: "bad topic" } }));
		expect(withBody.detail).toContain("bad topic");
		expect(withBody.message).toBe("400 Error");

		const textBody = classifyTavilyError(requestError(400, "plain text body"));
		expect(textBody.detail).toBe("plain text body");

		const noBody = classifyTavilyError(requestError(400, undefined, "  "));
		expect("detail" in noBody).toBe(false);
		expect(noBody.message).toBe("400 Error");
	});

	it("prefers the transport's own message when it has one", () => {
		expect(classifyTavilyError(requestError(429, { error: "slow down" }, "Too many requests")).message).toBe(
			"Too many requests",
		);
	});

	it("classifies a keyless-limit envelope as keyless-limit and explains the cap", () => {
		const failure = classifyTavilyError(keylessError());
		expect(failure.code).toBe("keyless-limit");
		expect(failure.status).toBe(429);
		expect(failure.message).toBe("Hourly keyless limit reached");
		expect(failure.detail).toContain("cap=hourly_keyless_limit");
		expect(failure.detail).toContain("retryAfter=900s");
		expect(failure.detail).not.toContain("bonusEligible");
	});

	it("reports the bonus path and no retry window when the envelope omits it", () => {
		const failure = classifyTavilyError(
			keylessError({ retryAfter: null, bonusEligible: true, capType: "daily_keyless_limit" }),
		);
		expect(failure.detail).toContain("bonusEligible=true");
		expect(failure.detail).toContain("cap=daily_keyless_limit");
		expect(failure.detail).not.toContain("retryAfter");
	});

	it("recognises the transport's timeout error by its prefix", () => {
		const failure = classifyTavilyError(new Error("Request timed out after 60 seconds."));
		expect(failure.code).toBe("timeout");
		expect(failure.message).toBe("Request timed out after 60 seconds.");
	});

	it("does not mistake a lookalike message for a timeout", () => {
		expect(classifyTavilyError(new Error("request timed out after 60 seconds.")).code).toBe("transport");
		expect(classifyTavilyError(new Error("  Request timed out after 1 seconds.")).code).toBe("timeout");
	});

	it("classifies abort errors from any source", () => {
		for (const name of ["AbortError", "CanceledError"]) {
			const error = Object.assign(new Error("The operation was aborted."), { name });
			expect(classifyTavilyError(error)).toEqual({ code: "aborted", message: "The operation was aborted." });
		}
		expect(classifyTavilyError(Object.assign(new Error(""), { name: "AbortError" }))).toEqual({
			code: "aborted",
			message: "The request was aborted.",
		});
	});

	it("falls back to transport for anything else, including non-errors", () => {
		expect(classifyTavilyError(new Error("socket hang up"))).toEqual({
			code: "transport",
			message: "socket hang up",
			detail: undefined,
		});
		expect(classifyTavilyError("boom").code).toBe("unknown");
		expect(classifyTavilyError("boom").message).toBe("boom");
		expect(classifyTavilyError(undefined).message).toContain("undefined");
		expect(classifyTavilyError({ status: 500 }).code).toBe("transport");
	});

	it("bounds detail so a hostile body cannot bloat a tool result", () => {
		const failure = classifyTavilyError(requestError(500, "x".repeat(TAVILY_DETAIL_MAX_CHARS * 3)));
		const detail = failure.detail ?? "";
		expect(detail).toHaveLength(TAVILY_DETAIL_MAX_CHARS + 1);
		expect(detail.endsWith("…")).toBe(true);
	});

	it("is idempotent through TavilyError", () => {
		const first = classifyTavilyError(requestError(429, { error: "slow" }));
		expect(classifyTavilyError(new TavilyError(first))).toEqual(first);
	});
});

describe("classifyTavilyError — vendor error shapes", () => {
	it("classifies every documented cap status as a cap, not as its status suggests", () => {
		// The vendor raises the cap class for several statuses, two of which an
		// HTTP-only classifier would read as auth or availability: its table pairs
		// 429 `*_cap_reached` with 401 `api_key_required`, 403 `abuse_blocked`,
		// 404 `unsupported_endpoint` and 503 `service_unavailable`
		// (`src/errors.ts:35-47`). The class, not the status, is the signal, and
		// `TavilyKeylessLimitError extends TavilyRequestError`, so testing the
		// parent first would silently mislabel every one of these.
		for (const [status, capType] of [
			[429, "hourly_cap_reached"],
			[401, "api_key_required"],
			[403, "abuse_blocked"],
			[404, "unsupported_endpoint"],
			[503, "service_unavailable"],
		] as const) {
			const cap = keylessError({ status, capType });
			expect(cap).toBeInstanceOf(TavilyRequestError);
			const failure = classifyTavilyError(cap);
			expect(failure.code).toBe("keyless-limit");
			expect(failure.status).toBe(status);
			expect(failure.detail).toContain(`cap=${capType}`);
		}
	});

	it("separates a plain 432 usage limit from a 429 rate limit and from a cap", () => {
		// 432 is in none of the vendor's tables, so a body without a cap envelope
		// must not read as `keyless-limit`, and it is not the documented 429 rate
		// limit either: it gets its own code, with status and body preserved.
		const plain = classifyTavilyError(requestError(432, { detail: { error: "Plan limit" } }, "Plan limit"));
		expect(plain.code).toBe("plan-limit");
		expect(plain.status).toBe(432);
		expect(plain.message).toBe("Plan limit");
		expect(plain.detail).toContain("Plan limit");

		const capped = classifyTavilyError(keylessError({ status: 432, capType: "monthly_cap_reached_pro" }));
		expect(capped.code).toBe("keyless-limit");
		expect(capped.status).toBe(432);

		expect(classifyTavilyError(requestError(429, { detail: "slow" })).code).toBe("rate-limit");
	});

	it("reports a validation failure as bad-request and never as a limit", () => {
		// A body whose `error` has a `code` but no `next_actions` array is not an
		// envelope (`src/errors.ts:88-98`), so the vendor raises the plain class:
		// the envelope's shape, not the status, is what makes a cap a cap.
		const validation = classifyTavilyError(
			new TavilyRequestError({ message: "bad", status: 400, body: { error: { code: "invalid_request" } } }),
		);
		expect(validation.code).toBe("bad-request");
		expect(validation.status).toBe(400);
		expect(validation.detail).toContain("invalid_request");
		expect(validation.code).not.toBe("keyless-limit");
		expect(validation.code).not.toBe("plan-limit");
		expect(validation.code).not.toBe("rate-limit");
	});

	it("classifies upstream failures as transport and keeps the status", () => {
		for (const status of [500, 502, 503, 504]) {
			const failure = classifyTavilyError(requestError(status, { detail: { error: "upstream" } }));
			expect(failure.code).toBe("transport");
			expect(failure.status).toBe(status);
			expect(failure.detail).toContain("upstream");
		}
	});

	it("reads an HTTP status off a plain object and calls anything else unknown", () => {
		// Not the vendor's own shape — a rehydrated or hand-built one — but an HTTP
		// status is worth honouring when nothing else identifies the failure.
		const plainBody = classifyTavilyError({
			status: 429,
			message: "429 Error: {}",
			body: { detail: { error: "slow down" } },
		});
		expect(plainBody.code).toBe("rate-limit");
		expect(plainBody.status).toBe(429);
		expect(plainBody.detail).toContain("slow down");

		expect(classifyTavilyError({ nope: true })).toEqual({
			code: "unknown",
			message: "Tavily request failed: [object Object]",
			detail: '{"nope":true}',
		});
		expect(classifyTavilyError(null)).toEqual({ code: "unknown", message: "Tavily request failed: null" });
	});

	it("never throws, whatever it is handed", () => {
		for (const value of [undefined, null, 0, "", false, NaN, [], {}, Symbol("x"), () => 0, Symbol.iterator]) {
			expect(() => classifyTavilyError(value)).not.toThrow();
			expect(typeof classifyTavilyError(value).code).toBe("string");
		}
	});
});

describe("TavilyError", () => {
	it("carries the failure as data and back", () => {
		const failure: TavilyFailure = { code: "rate-limit", message: "slow", status: 429, detail: "cap=x" };
		const error = new TavilyError(failure);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("TavilyError");
		expect(error.code).toBe("rate-limit");
		expect(error.status).toBe(429);
		expect(error.detail).toBe("cap=x");
		expect(error.toFailure()).toEqual(failure);
	});

	it("omits the optional fields the failure did not carry", () => {
		const error = new TavilyError({ code: "aborted", message: "stopped" });
		expect(error.status).toBeUndefined();
		expect(error.detail).toBeUndefined();
		// The return channel is what callers hand to a model: unset fields are absent, not undefined.
		expect(Object.keys(error.toFailure())).toEqual(["code", "message"]);
	});

	it("builds one from any throwable", () => {
		const error = TavilyError.from(requestError(401, { detail: "no key" }, "bad key"));
		expect(error).toBeInstanceOf(TavilyError);
		expect(error.code).toBe("auth");
		expect(error.status).toBe(401);
	});
});

describe("tavilyAborted", () => {
	it("reports a generic message with no signal", () => {
		expect(tavilyAborted()).toEqual({ code: "aborted", message: "The request was aborted before it completed." });
	});

	it("uses the signal's reason when it carries one", () => {
		const controller = new AbortController();
		controller.abort(new Error("user cancelled"));
		expect(tavilyAborted(controller.signal)).toEqual({ code: "aborted", message: "user cancelled" });

		const stringReason = new AbortController();
		stringReason.abort("timed out by budget");
		expect(tavilyAborted(stringReason.signal).message).toBe("timed out by budget");
	});

	it("falls back to the generic message when the reason says nothing", () => {
		const controller = new AbortController();
		controller.abort(new Error("   "));
		expect(tavilyAborted(controller.signal).message).toBe("The request was aborted before it completed.");
	});

	it("bounds a runaway abort reason", () => {
		const controller = new AbortController();
		controller.abort("y".repeat(TAVILY_DETAIL_MAX_CHARS + 500));
		expect(tavilyAborted(controller.signal).message).toHaveLength(TAVILY_DETAIL_MAX_CHARS + 1);
	});
});
