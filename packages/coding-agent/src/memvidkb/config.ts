/**
 * Configuration for the native `memvidkb` memory backend.
 *
 * Read through the fork's existing `.memvidkb` reader (`../internal-urls/knowledge-config`),
 * never a second parser. That file and the config repo's
 * `extensions/lib/knowledge/config.ts` are the document's only two readers, and a
 * third would let the schema drift silently between them — the drift the config repo's
 * `__tests__/knowledge-config-parity.test.ts` exists to catch. Only keys that already
 * exist there are read: `context`, `baseUrl`, `tokenEnvVar`, `providers`, `tracks`,
 * `remember`, `injectRecall`, `recallMaxBytes`. A new key must land in both readers and
 * that parity test in one change, so nothing here invents one. Of the reader's keys,
 * `version` is validated there and carries no runtime meaning here, and `startupRecall`
 * is still not carried: a query at session start is honest only once a recalled block can
 * be persisted and replayed byte-identically on resume, which is the startup-recall and
 * persistence slice's own work — not a key this module decided to ignore.
 *
 * The bearer is never stored in `.memvidkb`: the document names the env var holding it,
 * and a missing or empty value is a configuration error, never an unauthenticated call.
 * A whitespace-only value is accepted here, exactly as both readers accept it, and refused
 * at the send boundary by `./bearer` — one accept/reject line, not one per layer.
 */

import { KNOWLEDGE_ERROR_PREFIX } from "./errors";
import { loadMemvidkbConfig, type KnowledgeConfigResult } from "../internal-urls/knowledge-config";

/** What the backend needs from one resolved `.memvidkb`. */
export interface MemvidkbBackendConfig {
	/** Knowledge service origin with any trailing slashes removed. */
	baseUrl: string;
	/** Name of the env var holding the bearer — never the token itself. */
	tokenEnvVar: string;
	/** Bearer value, read from `tokenEnvVar` at load time and never persisted. */
	token: string;
	/** Context NAME this workspace's session is bound to. */
	context: string;
	/** Tracks this session is permitted to read, in `.memvidkb` order. */
	tracks: readonly string[];
	/**
	 * Gateway providers allowed to be named as the producer of a record this workspace
	 * writes — the operator's grant, read straight from `.memvidkb`'s `providers`.
	 *
	 * Empty — also what an absent key collapses to in the authoritative reader — is
	 * deliberately NOT a restriction: it defers to the context's own `allowedProviders` on
	 * the service, so a workspace that never wrote the key keeps writing exactly as before.
	 * Only a non-empty list restricts, and it admits by exact name or by the `"*"` wildcard
	 * — the same rule the config repo enforces at
	 * `extensions/lib/knowledge/config.ts:426-436`, so both planes answer for one document.
	 * The refusal lives in {@link providerDenial}.
	 */
	providers: readonly string[];
	/** Whether explicit writes are permitted at all. */
	remember: "off" | "on";
	/**
	 * Whether recall may reach a model unprompted. Gates the two automatic recall
	 * paths (`beforeAgentStartPrompt`, `preCompactionContext`); an explicit
	 * `memory_search` is a model-requested read and is never gated by it.
	 */
	injectRecall: boolean;
	/** Byte ceiling for automatically injected recall, enforced by the injecting layer. */
	recallMaxBytes: number;
}

/** One config load: the resolved backend config, or a prefixed failure. */
export type MemvidkbBackendConfigResult =
	| { readonly ok: true; readonly config: MemvidkbBackendConfig }
	| { readonly ok: false; readonly error: string };

/** Strip trailing slashes so a route path can be appended without doubling them. */
function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

/**
 * Resolve this workspace's `.memvidkb` into what the backend needs.
 *
 * @param cwd - Workspace root the upward `.memvidkb` search starts from.
 * @returns The resolved config, or a `knowledge_invalid_config:` failure naming the code.
 */
export async function loadMemvidkbBackendConfig(cwd: string): Promise<MemvidkbBackendConfigResult> {
	const loaded: KnowledgeConfigResult = await loadMemvidkbConfig(cwd);
	if ("err" in loaded) {
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.invalidConfig}${loaded.err.msg} (code ${loaded.err.code}, workspace ${cwd})`,
		};
	}
	const config = loaded.ok;
	// Mirrors the shared reader's gate exactly, byte for byte: unset or zero-length is the
	// refusal, anything else (including padding) loads. Normalising here instead would give
	// this layer its own accept/reject line, which no harness can check against the other
	// two readers.
	const token = process.env[config.tokenEnvVar];
	if (typeof token !== "string" || token.length === 0) {
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.invalidConfig}Bearer token env var "${config.tokenEnvVar}" is unset or empty (code TOKEN_ENV_UNSET). Unauthenticated requests are never attempted.`,
		};
	}
	return {
		ok: true,
		config: {
			baseUrl: normalizeBaseUrl(config.baseUrl),
			tokenEnvVar: config.tokenEnvVar,
			token,
			context: config.context,
			tracks: config.tracks,
			providers: config.providers,
			remember: config.remember,
			injectRecall: config.injectRecall,
			recallMaxBytes: config.recallMaxBytes,
		},
	};
}

/**
 * Pick the track this backend reads and writes by default.
 *
 * `.memvidkb` carries a permission list rather than a chosen track, so the default is
 * the first permitted entry: deterministic, and always inside the operator's grant. A
 * context with no permitted track cannot search or save, and is refused rather than
 * silently pointed at a track nobody granted.
 *
 * @param config - Resolved backend config.
 * @returns The default track, or a `knowledge_forbidden:` refusal naming the context.
 */
export function selectDefaultTrack(
	config: MemvidkbBackendConfig,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
	const track = config.tracks.find(candidate => candidate.trim().length > 0);
	if (track === undefined) {
		const permitted = config.tracks.length > 0 ? config.tracks.join(", ") : "none configured";
		return {
			ok: false,
			error: `${KNOWLEDGE_ERROR_PREFIX.forbidden}No usable track is permitted for context "${config.context}" (permitted tracks: ${permitted}), so nothing was sent. Ask the operator to add a track to .memvidkb.`,
		};
	}
	return { ok: true, value: track };
}

/**
 * Refuse a write whose named producer the context's `.memvidkb` does not admit.
 *
 * The shape mirrors the config repo's `providerDenial`
 * (`extensions/lib/knowledge/config.ts:426-436`) exactly: both planes read the same
 * document, and an operator must get one voice from either side of it. An absent or blank
 * provider is not refused — the caller named no producer, and the service decides. An
 * EMPTY list is no restriction at all, deferring to the context's `allowedProviders`
 * server-side. Only a non-empty list admits, by exact name or by the `"*"` wildcard. The
 * refusal names the key, the offending value and the admitted list, because one line has
 * to be enough to fix the file.
 *
 * @param config - Context name plus the operator's provider grant from `.memvidkb`.
 * @param provider - Gateway provider the write attributes its content to, if it names one.
 * @returns A `knowledge_forbidden:` refusal naming key, value and list; `undefined` when
 * the provider is admitted or when no provider was named.
 */
export function providerDenial(
	config: { readonly context?: string; readonly providers?: readonly string[] },
	provider: string | undefined,
): string | undefined {
	const requested = provider?.trim();
	if (requested === undefined || requested.length === 0) return undefined;
	// Absent is the same absence as empty: no local rule, and the service decides.
	const granted = config.providers ?? [];
	if (granted.length === 0) return undefined;
	if (granted.includes(requested) || granted.includes("*")) return undefined;
	const admitted = granted.join(", ");
	return (
		`${KNOWLEDGE_ERROR_PREFIX.forbidden}provider "${requested}" is not admitted for ` +
		`context "${config.context ?? "(unknown)"}" by .memvidkb "providers"; this context ` +
		`admits: ${admitted}. Nothing was sent and no substitute provider was used.`
	);
}
