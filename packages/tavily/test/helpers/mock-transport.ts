/**
 * A recording stand-in for `TavilyTransport`.
 *
 * The HTTP-level tests use the real axios path; this one exists for the facts
 * that path cannot show without waiting on a wall clock — which endpoint a verb
 * names, whether a `requestId` was URL-encoded on the way into the path, and
 * which per-verb timeout budget reached the transport. Those are decisions made
 * in `verbs.ts`, and they are invisible in a response body.
 */

import type { TavilyClient, TavilyTransport } from "../../src/index";

/** One transport call as the verb made it. */
export interface RecordedCall {
	kind: "post" | "get" | "stream";
	endpoint: string;
	/** Body for `post` and `stream`. */
	body?: Record<string, unknown>;
	/** Query parameters for `get`. */
	params?: Record<string, unknown>;
	opts?: { timeoutSeconds?: number; headers?: Record<string, string> };
}

export interface StubClient {
	readonly client: TavilyClient;
	readonly calls: readonly RecordedCall[];
	/** The most recent call, or `undefined`. */
	last(): RecordedCall | undefined;
}

export interface StubOptions {
	/** Value the transport resolves, keyed by endpoint (exact match). */
	replies?: Record<string, unknown>;
	/** Thrown instead of resolving, to exercise the failure paths. */
	throw?: (call: RecordedCall) => unknown;
	hasApiKey?: boolean;
	apiKey?: string;
	/** Bytes yielded by `stream`, so a verb can be tested without a socket. */
	streamChunks?: Buffer[];
	/**
	 * A generator of the caller's own, for the cases a fixed chunk list cannot
	 * express: a stream that stalls after its first event, so an abort can be
	 * delivered while the verb is genuinely waiting for the next one.
	 */
	streamGenerator?: () => AsyncGenerator<Buffer, void, unknown>;
}

/** A client whose transport records every call and never touches the network. */
export function stubClient(options: StubOptions = {}): StubClient {
	const calls: RecordedCall[] = [];

	const record = (call: RecordedCall): void => {
		calls.push(call);
		if (options.throw) throw options.throw(call);
	};

	const transport: TavilyTransport = {
		async post<T>(endpoint: string, body: Record<string, unknown>, opts?: RecordedCall["opts"]): Promise<T> {
			record({ kind: "post", endpoint, body, opts });
			return (options.replies?.[endpoint] ?? {}) as T;
		},
		async get<T>(endpoint: string, opts?: RecordedCall["opts"] & { params?: Record<string, unknown> }): Promise<T> {
			const { timeoutSeconds, headers, params } = opts ?? {};
			record({ kind: "get", endpoint, params, opts: { timeoutSeconds, headers } });
			return (options.replies?.[endpoint] ?? {}) as T;
		},
		async stream(
			endpoint: string,
			body: Record<string, unknown>,
			opts?: RecordedCall["opts"],
		): Promise<AsyncGenerator<Buffer, void, unknown>> {
			record({ kind: "stream", endpoint, body, opts });
			if (options.streamGenerator) return options.streamGenerator();
			const chunks = options.streamChunks ?? [];
			return (async function* () {
				for (const chunk of chunks) yield chunk;
			})();
		},
	};

	const client: TavilyClient = Object.freeze({
		apiKey: options.apiKey ?? (options.hasApiKey === false ? undefined : "sk-stub"),
		hasApiKey: options.hasApiKey ?? true,
		apiBaseURL: "https://stub.invalid",
		clientSource: "omp",
		clientName: "omp/test",
		transport,
	});

	return {
		client,
		calls,
		last: () => calls[calls.length - 1],
	};
}
