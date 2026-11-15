/**
 * A loopback HTTP server that stands in for `https://api.tavily.com`.
 *
 * The verbs are tested through the real axios path in `@tavily/core`, not
 * around it: a stubbed transport would not catch the things that actually break
 * here — snake_case keys arriving with the wrong spelling, headers the identity
 * passthrough forgets to set, a non-2xx body that has to be read before it can
 * be classified, a stream that is written in awkward pieces.
 *
 * Listens on port 0, so nothing contends with a fixed port, and each reply may
 * be written in deliberate chunks with a delay, which is the only way to make
 * chunk boundaries in the streaming decoder real rather than theoretical.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request as the server saw it. */
export interface RecordedRequest {
	method: string;
	/** Pathname without the query string. */
	path: string;
	/** Decoded query parameters. */
	query: Record<string, string>;
	headers: NodeJS.Dict<string | string[]>;
	/** Request body exactly as received. */
	rawBody: string;
	/** Parsed JSON body, or `undefined` when the body was not JSON. */
	body: unknown;
}

/** What the server should answer with. */
export interface MockReply {
	status?: number;
	/** JSON body, serialised for the response. */
	body?: unknown;
	/** Body to send verbatim, for anything that is not valid JSON. */
	text?: string;
	/**
	 * Pieces to write separately, for a streamed reply. A `Buffer` lets a test
	 * cut a reply in the middle of a multibyte character, which no string split
	 * can express.
	 */
	chunks?: Array<string | Buffer>;
	contentType?: string;
	/** Gap between `chunks`; small values still produce real socket boundaries. */
	chunkDelayMs?: number;
	/** Never answer: the response is left open, for timeout and abort tests. */
	hold?: boolean;
}

export type MockHandler = (request: RecordedRequest) => MockReply | Promise<MockReply>;

export interface MockTavilyServer {
	/** Value to pass as `apiBaseURL`. */
	readonly baseUrl: string;
	/** Every request received, in order. */
	readonly requests: readonly RecordedRequest[];
	/** The most recent request, or `undefined` when nothing arrived. */
	lastRequest(): RecordedRequest | undefined;
	/** Requests whose pathname equals `path`. */
	requestsTo(path: string): RecordedRequest[];
	/**
	 * Resolve once at least `count` requests have arrived. Lets a test act at the
	 * moment a request is really in flight — aborting mid-request, for instance —
	 * instead of guessing a duration and hoping the race went the right way.
	 */
	waitForRequest(count?: number): Promise<void>;
	close(): Promise<void>;
}

/**
 * Real time, deliberately: this is what produces distinct socket writes, which
 * is the condition the streaming decoder is tested against. Fake timers cannot
 * make two writes arrive as two reads.
 */
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function parseBody(rawBody: string, contentType: string | undefined): unknown {
	if (rawBody.length === 0) return undefined;
	if (contentType !== undefined && !contentType.includes("json")) return undefined;
	try {
		return JSON.parse(rawBody);
	} catch {
		return undefined;
	}
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	const pieces: Buffer[] = [];
	for await (const chunk of req) pieces.push(chunk as Buffer);
	return Buffer.concat(pieces).toString("utf8");
}

async function respond(res: ServerResponse, reply: MockReply): Promise<void> {
	const status = reply.status ?? 200;
	if (reply.hold === true) return;
	if (reply.chunks !== undefined) {
		res.writeHead(status, {
			"content-type": reply.contentType ?? "text/event-stream",
			"transfer-encoding": "chunked",
		});
		for (const chunk of reply.chunks) {
			res.write(chunk);
			if (reply.chunkDelayMs !== undefined) await delay(reply.chunkDelayMs);
		}
		res.end();
		return;
	}
	const body = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
	res.writeHead(status, {
		"content-type": reply.contentType ?? "application/json",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

/**
 * Start the stand-in server. `handler` decides each reply from the request, so
 * one server can serve several endpoints, and a test that expects no request at
 * all can assert on `requests` being empty.
 *
 * A reply whose `status` is 0 means "never answer": the response is left open,
 * which is how a caller exercises a timeout or an abort. Always `close()` in a
 * `finally` — it destroys the open sockets so the test process can exit.
 */
export async function startMockTavilyServer(handler: MockHandler): Promise<MockTavilyServer> {
	const requests: RecordedRequest[] = [];
	const sockets = new Set<Socket>();
	const waiters = new Map<number, () => void>();

	const settleWaiters = (): void => {
		for (const [count, resolve] of waiters) {
			if (requests.length < count) continue;
			waiters.delete(count);
			resolve();
		}
	};

	const server: Server = createServer((req, res) => {
		void (async () => {
			const rawBody = await readRequestBody(req);
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const recorded: RecordedRequest = {
				method: req.method ?? "GET",
				path: url.pathname,
				query: Object.fromEntries(url.searchParams.entries()),
				headers: req.headers,
				rawBody,
				body: parseBody(rawBody, req.headers["content-type"]),
			};
			requests.push(recorded);
			settleWaiters();
			try {
				await respond(res, await handler(recorded));
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(error) }));
			}
		})();
	});

	server.on("connection", socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		lastRequest: () => requests[requests.length - 1],
		requestsTo: path => requests.filter(request => request.path === path),
		waitForRequest: (count = 1) => {
			const waiter = Promise.withResolvers<void>();
			if (requests.length >= count) waiter.resolve();
			else waiters.set(count, waiter.resolve);
			return waiter.promise;
		},
		close: async () => {
			for (const [count, resolve] of waiters) {
				waiters.delete(count);
				resolve();
			}
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections?.();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

/** Reply helper: a JSON body with an explicit status. */
export function json(body: unknown, status = 200): MockReply {
	return { status, body };
}

/** Reply helper: hold the connection open so the caller can time out or abort. */
export function hold(): MockReply {
	return { hold: true };
}
