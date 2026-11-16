/**
 * Failure taxonomy for the native `memvidkb` memory backend.
 *
 * The prefix strings are byte-identical to the config repo's
 * `extensions/lib/knowledge/errors.ts` (`ERROR_PREFIX`) on purpose. The two
 * clients can never share code — an extension compiles against the published
 * `@oh-my-pi/pi-coding-agent`, which resolves no fork-only module — but a caller
 * classifying a knowledge failure must be able to use ONE match for either side.
 *
 * The load-bearing distinction is between
 * {@link KNOWLEDGE_ERROR_PREFIX.unreachable} (the service could not be reached, or
 * answered 429/5xx: an outage) and {@link KNOWLEDGE_ERROR_PREFIX.unavailable} (the
 * service answered and this client could not honour the answer, or the request was
 * refused before it reached the wire). Neither is ever rendered as an empty result
 * set: an outage has to read as an outage.
 */
export const KNOWLEDGE_ERROR_PREFIX = {
	/** `.memvidkb` is missing, unparsable, or refused by the loader. */
	invalidConfig: "knowledge_invalid_config: ",
	/** The service rejected the bearer (HTTP 401). */
	unauthorized: "knowledge_unauthorized: ",
	/** Consent or policy refusal: service 403, or a local gate that never sent the call. */
	forbidden: "knowledge_forbidden: ",
	/** Transport failure, timeout, or 429/5xx. Never reported as success. */
	unreachable: "knowledge_unreachable: ",
	/** Answered, but unreadable; or refused before sending. Retrying can plausibly help. */
	unavailable: "knowledge_unavailable: ",
	/** Resource unknown to this context (HTTP 404). */
	notFound: "knowledge_not_found: ",
} as const;

/** Every taxonomy prefix, so a caller can assert "exactly one, from this set". */
export const KNOWLEDGE_ERROR_PREFIXES: readonly string[] = Object.values(KNOWLEDGE_ERROR_PREFIX);

/** True when `text` opens with exactly one taxonomy prefix. */
export function hasKnowledgeErrorPrefix(text: string): boolean {
	return KNOWLEDGE_ERROR_PREFIXES.some(prefix => text.startsWith(prefix));
}

/**
 * Scrub the bearer out of service-produced text before it can reach a log or a model.
 *
 * @param text - Candidate text, typically an echoed error body.
 * @param token - Bearer value that must never be echoed back.
 * @returns `text` with every occurrence of `token` replaced, unchanged when empty.
 */
export function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("[redacted]");
}
