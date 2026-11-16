/**
 * The bearer's single normaliser for the native `memvidkb` backend.
 *
 * It lives here, next to the transport that uses it, rather than in the config loader,
 * because the two `.memvidkb` readers (`../internal-urls/knowledge-config` and the config
 * repo's `extensions/lib/knowledge/config.ts`) both ACCEPT a whitespace-only bearer at load
 * and refuse it at the send boundary — see the config repo's
 * `__tests__/knowledge-config-parity.test.ts:117-123`, which asserts
 * `loadMemvidkb(workspace, () => "   ")` produces no error and only the later resolve
 * refuses. A backend-specific load rule would be a third accept/reject line, invisible to
 * the harness that pins the other two, so instead nothing reaches `fetch` without a sendable
 * bearer: the padded value goes out trimmed, and the blank one is refused before the socket.
 */

import { KNOWLEDGE_ERROR_PREFIX } from "./errors";

/** What a send needs from the endpoint: the bearer value and the name of its env var. */
export type BearerSource = { readonly tokenEnvVar: string; readonly token: string };

/** The trimmed bearer, or the refusal naming the variable that holds nothing sendable. */
export type BearerResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly error: string };

/**
 * Trim the bearer and refuse it when nothing would be sent.
 *
 * @param source - The endpoint's bearer value and the env var it came from.
 * @returns The value to put on the wire, or a `knowledge_invalid_config:` refusal.
 */
export function normalizeBearer(source: BearerSource): BearerResult {
	const value = source.token.trim();
	if (value.length === 0) {
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.invalidConfig}Bearer token env var "${source.tokenEnvVar}" holds no sendable value (code TOKEN_ENV_UNSET). Unauthenticated requests are never attempted.`,
		};
	}
	return { ok: true, value };
}
