/**
 * Streaming research: bytes in, report pieces out.
 *
 * `@tavily/core` hands back a generator of raw `Buffer`s over the response
 * body; everything a UI needs is decided here — where a line ends, whether an
 * event is JSON or plain text, what a partial multibyte character does to the
 * text, and how the stream says it is over. The socket cases go through real
 * HTTP with delayed writes, because a stub that hands over one whole string
 * would test none of that.
 */

import { describe, expect, it } from "bun:test";
import { createTavilyClient, tavilyResearchStream, type TavilyResearchChunk } from "../src/index";
import { json, startMockTavilyServer, type MockHandler, type MockTavilyServer } from "./helpers/mock-server";
import { stubClient } from "./helpers/mock-transport";
import { KEYLESS_ENV, withEnv } from "./helpers/env";

async function withServer<T>(handler: MockHandler, run: (server: MockTavilyServer) => Promise<T>): Promise<T> {
	const server = await startMockTavilyServer(handler);
	try {
		return await run(server);
	} finally {
		await server.close();
	}
}

async function collect(generator: AsyncGenerator<TavilyResearchChunk>): Promise<TavilyResearchChunk[]> {
	const chunks: TavilyResearchChunk[] = [];
	for await (const chunk of generator) chunks.push(chunk);
	return chunks;
}

const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

describe("tavilyResearchStream over HTTP", () => {
	it("emits one chunk per event, in order, with text and parsed fields", async () => {
		await withServer(
			() => ({
				chunks: [
					event({ status: "in_progress", request_id: "r1" }),
					event({ content: "Tavily is " }),
					event({ content: "a search API." }),
					"\n",
					event({ status: "complete", response_time: 3.5 }),
				],
				chunkDelayMs: 5,
			}),
			async server => {
				const client = createTavilyClient({ apiBaseURL: server.baseUrl, apiKey: "sk-test" });
				const chunks = await collect(tavilyResearchStream(client, { input: "what is tavily" }));

				expect(chunks.map(chunk => chunk.text)).toEqual(["", "Tavily is ", "a search API.", ""]);
				expect(chunks[0]?.record).toEqual({ requestId: "r1", status: "in_progress" });
				expect(chunks[3]?.record).toEqual({ status: "complete", responseTime: 3.5 });
				expect(chunks.some(chunk => chunk.error !== undefined)).toBe(false);

				const request = server.lastRequest();
				expect(request?.path).toBe("/research");
				expect(request?.body).toEqual({ input: "what is tavily", stream: true });
				expect(request?.headers["content-type"]).toContain("application/json");
			},
		);
	});

	it("accepts plain lines, drops keep-alives, and never leaks a Buffer", async () => {
		await withServer(
			() => ({
				chunks: ["raw prose line\n", ": keep-alive\n\n", "data: [DONE]\n", "data:", "  \n", "\n\n"],
				chunkDelayMs: 5,
			}),
			async server => {
				const client = createTavilyClient({ apiBaseURL: server.baseUrl, apiKey: "sk-test" });
				const chunks = await collect(tavilyResearchStream(client, { input: "x" }));
				expect(chunks.map(chunk => chunk.text)).toEqual(["raw prose line", ": keep-alive"]);
				for (const chunk of chunks) expect(typeof chunk.text).toBe("string");
			},
		);
	});

	it("keeps a multibyte character whole across a chunk boundary", async () => {
		const payload = Buffer.from(event({ content: "世界 — ok" }), "utf8");
		const cut = payload.indexOf(Buffer.from("世", "utf8")) + 1; // inside the 3-byte sequence
		expect(cut).toBeGreaterThan(0);

		await withServer(
			() => ({ chunks: [payload.subarray(0, cut), payload.subarray(cut)], chunkDelayMs: 5 }),
			async server => {
				const client = createTavilyClient({ apiBaseURL: server.baseUrl, apiKey: "sk-test" });
				const chunks = await collect(tavilyResearchStream(client, { input: "x" }));
				expect(chunks).toHaveLength(1);
				expect(chunks[0]?.text).toBe("世界 — ok");
			},
		);
	});

	it("carries a malformed JSON event through as text rather than dropping it", async () => {
		await withServer(
			() => ({ chunks: ['data: {"content": "unterminated\n\n'] }),
			async server => {
				const client = createTavilyClient({ apiBaseURL: server.baseUrl, apiKey: "sk-test" });
				const chunks = await collect(tavilyResearchStream(client, { input: "x" }));
				expect(chunks).toHaveLength(1);
				expect(chunks[0]?.text).toBe('{"content": "unterminated');
			},
		);
	});

	it("ends with a rate-limit chunk when the submit is refused before any byte", async () => {
		await withServer(
			() => json({ error: "slow down" }, 429),
			async server => {
				const client = createTavilyClient({ apiBaseURL: server.baseUrl, apiKey: "sk-test" });
				const chunks = await collect(tavilyResearchStream(client, { input: "x" }));
				expect(chunks).toHaveLength(1);
				expect(chunks[0]?.text).toBe("");
				expect(chunks[0]?.error?.code).toBe("rate-limit");
				expect(chunks[0]?.error?.status).toBe(429);
			},
		);
	});
});

describe("tavilyResearchStream without a key", () => {
	it("yields one terminal auth chunk and never reaches the transport", async () => {
		const stub = stubClient({ hasApiKey: false, apiKey: undefined });
		const chunks = await collect(tavilyResearchStream(stub.client, { input: "x" }));
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.error?.code).toBe("auth");
		expect(chunks[0]?.error?.message).toContain("Keyless mode only supports search and extract");
		expect(stub.calls).toHaveLength(0);
	});

	it("says the same thing over real HTTP, with no request sent", async () => {
		await withServer(
			() => json({}),
			async server => {
				const chunks = await withEnv(KEYLESS_ENV, async () => {
					const client = createTavilyClient({ apiBaseURL: server.baseUrl });
					return await collect(tavilyResearchStream(client, { input: "x" }));
				});
				expect(chunks).toHaveLength(1);
				expect(chunks[0]?.error?.code).toBe("auth");
				expect(server.requests).toHaveLength(0);
			},
		);
	});

	it("refuses an already-aborted signal before doing anything", async () => {
		const stub = stubClient();
		const controller = new AbortController();
		controller.abort();
		const chunks = await collect(tavilyResearchStream(stub.client, { input: "x" }, controller.signal));
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.error?.code).toBe("aborted");
		expect(stub.calls).toHaveLength(0);
	});
});

describe("aborting a live stream", () => {
	it("terminates with an aborted chunk while waiting for the next event", async () => {
		const controller = new AbortController();
		const stub = stubClient({
			streamGenerator: async function* () {
				yield Buffer.from(event({ content: "first" }), "utf8");
				// Stall the way a real socket does: no further bytes until the caller
				// cancels, at which point the read rejects the way Node's stream does.
				const { promise, reject } = Promise.withResolvers<never>();
				controller.signal.addEventListener("abort", () => {
					const error = new Error("stream cancelled");
					error.name = "AbortError";
					reject(error);
				});
				await promise;
			},
		});

		const chunks: TavilyResearchChunk[] = [];
		for await (const chunk of tavilyResearchStream(stub.client, { input: "x" }, controller.signal)) {
			chunks.push(chunk);
			if (chunk.text === "first") controller.abort();
		}

		expect(chunks.map(chunk => chunk.text)).toEqual(["first", ""]);
		expect(chunks[0]?.record).toEqual({ content: "first" });
		expect(chunks[1]?.error?.code).toBe("aborted");
		expect(stub.last()).toMatchObject({ kind: "stream", endpoint: "research" });
		expect(stub.last()?.body).toEqual({ input: "x", stream: true });
	});
});
