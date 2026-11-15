/**
 * The one Tavily client in the ecosystem.
 *
 * It owns transport construction and identity: the API key resolution, the
 * `omp` client headers, proxy and project passthrough. It deliberately does
 * not call `tavily()` from `@tavily/core` — the verbs in `verbs.ts` build their
 * own request bodies and normalise their own responses, because three of the
 * upstream normalisers are broken. What is reused is the transport: axios, the
 * proxy agents, header construction, the research-has-no-default-timeout rule,
 * and the two error classes.
 */

import { createTransport } from "@tavily/core";
import { version } from "../package.json" with { type: "json" };
import type { TavilyClient, TavilyClientOptions } from "./types";

/** API root used when the caller does not override `apiBaseURL`. */
export const DEFAULT_TAVILY_API_BASE_URL = "https://api.tavily.com";

/** `X-Client-Source` used when the caller does not override `clientSource`. */
export const DEFAULT_TAVILY_CLIENT_SOURCE = "omp";

/** Version of this package, read from its own manifest so it cannot drift. */
export const PACKAGE_VERSION: string = version;

/** `X-Client-Name` used when the caller does not override `clientName`. */
export const DEFAULT_TAVILY_CLIENT_NAME = `omp/${PACKAGE_VERSION}`;

/** A configured value only counts when it has content after trimming. */
function usable(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the API key: an explicit `options.apiKey`, else `TAVILY_API_KEY`,
 * each trimmed and rejected when empty.
 *
 * An empty explicit key falls through to the environment rather than forcing a
 * keyless client, so this function's "no key" answer always agrees with the
 * transport's own `apiKey || TAVILY_API_KEY` rule. If the two could disagree, a
 * keyless client would still send a bearer token — and the keyless gate in
 * `verbs.ts` would be blocking verbs whose request the transport would have
 * authenticated anyway.
 */
export function resolveTavilyApiKey(options: TavilyClientOptions = {}): string | undefined {
	return usable(options.apiKey) ?? usable(process.env.TAVILY_API_KEY);
}

/**
 * Whether a Tavily API key is available.
 *
 * With a client, reports what that client resolved; with no argument, reports
 * whether the environment would produce one. Callers use this to decide
 * whether to advertise the credentialed verbs at all.
 */
export function tavilyKeyAvailable(client?: TavilyClient): boolean {
	return client === undefined ? resolveTavilyApiKey() !== undefined : client.hasApiKey;
}

/**
 * Build a Tavily client. Never throws for a missing key: a client with no key
 * is a valid, keyless client, and {@link tavilySearch}/{@link tavilyExtract}
 * still work against it.
 */
export function createTavilyClient(options: TavilyClientOptions = {}): TavilyClient {
	const apiKey = resolveTavilyApiKey(options);
	const apiBaseURL = usable(options.apiBaseURL) ?? DEFAULT_TAVILY_API_BASE_URL;
	const clientSource = usable(options.clientSource) ?? DEFAULT_TAVILY_CLIENT_SOURCE;
	const clientName = usable(options.clientName) ?? DEFAULT_TAVILY_CLIENT_NAME;

	// `apiKey` is passed through resolved, so the transport's header choice
	// (bearer vs `X-Tavily-Access-Mode: keyless`) matches `hasApiKey` exactly.
	const transport = createTransport({
		apiKey,
		apiBaseURL,
		clientSource,
		clientName,
		sessionId: options.sessionId,
		humanId: options.humanId,
		projectId: usable(options.projectId) ?? usable(process.env.TAVILY_PROJECT),
		orgId: usable(options.orgId) ?? usable(process.env.TAVILY_ORG_ID),
		proxies: options.proxies,
		adapter: options.adapter,
	});

	return Object.freeze({
		apiKey,
		hasApiKey: apiKey !== undefined,
		apiBaseURL,
		clientSource,
		clientName,
		transport,
	});
}
