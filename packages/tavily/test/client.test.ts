/**
 * Client construction: what a caller gets from `createTavilyClient`, and what
 * the transport actually puts on the wire.
 *
 * The header assertions are made against a real axios request, not against the
 * options object, because the header set is built inside `@tavily/core` and the
 * thing that breaks is a value that never reaches the socket — an `omp` client
 * source that silently reverts to `tavily-js`, or a keyless client that sends a
 * `Bearer` header with an undefined key.
 */

import { describe, expect, it } from "bun:test";
import manifest from "../package.json" with { type: "json" };
import {
	PACKAGE_VERSION,
	DEFAULT_TAVILY_API_BASE_URL,
	DEFAULT_TAVILY_CLIENT_NAME,
	DEFAULT_TAVILY_CLIENT_SOURCE,
	createTavilyClient,
	resolveTavilyApiKey,
	tavilyKeyAvailable,
	tavilySearch,
} from "../src/index";
import { startMockTavilyServer, json } from "./helpers/mock-server";
import { KEYLESS_ENV, withEnv } from "./helpers/env";

describe("resolveTavilyApiKey", () => {
	it("prefers an explicit key over the environment", async () => {
		await withEnv({ TAVILY_API_KEY: "env-key" }, () => {
			expect(resolveTavilyApiKey({ apiKey: "explicit" })).toBe("explicit");
			expect(resolveTavilyApiKey()).toBe("env-key");
			expect(resolveTavilyApiKey({})).toBe("env-key");
		});
	});

	it("trims, and treats blank as absent", async () => {
		await withEnv(KEYLESS_ENV, () => {
			expect(resolveTavilyApiKey({ apiKey: "  padded  " })).toBe("padded");
			expect(resolveTavilyApiKey({ apiKey: "   " })).toBeUndefined();
			expect(resolveTavilyApiKey({ apiKey: "" })).toBeUndefined();
		});
	});

	it("falls back to the environment when the explicit key is blank, matching the transport", async () => {
		// The transport decides with `apiKey || TAVILY_API_KEY`. If an explicit
		// blank key forced a keyless client here, that client would still send a
		// bearer token, and the keyless gate in verbs.ts would refuse verbs the
		// transport was about to authenticate anyway.
		await withEnv({ ...KEYLESS_ENV, TAVILY_API_KEY: "env-key" }, () => {
			expect(resolveTavilyApiKey({ apiKey: "  " })).toBe("env-key");
			expect(createTavilyClient({ apiKey: "" }).hasApiKey).toBe(true);
		});
	});

	it("reports no key when neither source has one", async () => {
		await withEnv(KEYLESS_ENV, () => {
			expect(resolveTavilyApiKey()).toBeUndefined();
			expect(tavilyKeyAvailable()).toBe(false);
			expect(tavilyKeyAvailable(createTavilyClient())).toBe(false);
		});
	});
});

describe("createTavilyClient", () => {
	it("applies the omp defaults and exposes a live transport", async () => {
		await withEnv(KEYLESS_ENV, () => {
			const client = createTavilyClient();
			expect(client.apiKey).toBeUndefined();
			expect(client.hasApiKey).toBe(false);
			expect(client.apiBaseURL).toBe(DEFAULT_TAVILY_API_BASE_URL);
			expect(client.clientSource).toBe(DEFAULT_TAVILY_CLIENT_SOURCE);
			expect(client.clientName).toBe(DEFAULT_TAVILY_CLIENT_NAME);
			expect(client.clientName).toBe(`omp/${PACKAGE_VERSION}`);
			expect(typeof client.transport.post).toBe("function");
			expect(typeof client.transport.get).toBe("function");
			expect(typeof client.transport.stream).toBe("function");
		});
	});

	it("takes its version from its own manifest, so it cannot drift", () => {
		expect(PACKAGE_VERSION).toBe(manifest.version);
	});

	it("is frozen, so a caller cannot rewrite another call's identity", async () => {
		await withEnv(KEYLESS_ENV, () => {
			const client = createTavilyClient({ apiKey: "k" });
			expect(Object.isFrozen(client)).toBe(true);
			expect(() => {
				(client as { apiKey: string | undefined }).apiKey = "other";
			}).toThrow();
		});
	});

	it("resolves project and org identity from the environment when the caller leaves them blank", async () => {
		const server = await startMockTavilyServer(() => json({ results: [] }));
		try {
			await withEnv(
				{ ...KEYLESS_ENV, TAVILY_API_KEY: "sk", TAVILY_PROJECT: "proj-9", TAVILY_ORG_ID: "org-9" },
				async () => {
					// A blank explicit value must fall through to the environment, exactly as the key does.
					await tavilySearch(
						createTavilyClient({ apiBaseURL: server.baseUrl, projectId: "  ", orgId: "explicit-org" }),
						{ query: "hello" },
					);
				},
			);
			const request = server.lastRequest();
			expect(request?.headers["x-project-id"]).toBe("proj-9");
			expect(request?.headers["x-tavily-orgid"]).toBe("explicit-org");
		} finally {
			await server.close();
		}
	});

	it("trims the base url and keeps an explicit one", async () => {
		await withEnv(KEYLESS_ENV, () => {
			expect(createTavilyClient({ apiBaseURL: "  https://t.example/  " }).apiBaseURL).toBe("https://t.example/");
			expect(createTavilyClient({ apiBaseURL: "   " }).apiBaseURL).toBe(DEFAULT_TAVILY_API_BASE_URL);
		});
	});
});

describe("identity on the wire", () => {
	it("sends the omp headers and a bearer token when a key is configured", async () => {
		const server = await startMockTavilyServer(() => json({ results: [] }));
		try {
			await withEnv({ ...KEYLESS_ENV, TAVILY_API_KEY: "  sk-test-key  " }, async () => {
				const client = createTavilyClient({
					apiBaseURL: server.baseUrl,
					sessionId: "sess-1",
					humanId: "human-1",
					projectId: "proj-1",
					orgId: "org-1",
				});
				const result = await tavilySearch(client, { query: "hello" });
				expect(result.ok).toBe(true);
			});

			const request = server.lastRequest();
			expect(request?.method).toBe("POST");
			expect(request?.path).toBe("/search");
			expect(request?.headers.authorization).toBe("Bearer sk-test-key");
			expect(request?.headers["x-tavily-access-mode"]).toBeUndefined();
			expect(request?.headers["x-client-source"]).toBe("omp");
			expect(request?.headers["x-client-name"]).toBe(`omp/${PACKAGE_VERSION}`);
			expect(request?.headers["x-session-id"]).toBe("sess-1");
			expect(request?.headers["x-human-id"]).toBe("human-1");
			expect(request?.headers["x-project-id"]).toBe("proj-1");
			expect(request?.headers["x-tavily-orgid"]).toBe("org-1");
			expect(request?.headers["content-type"]).toContain("application/json");
		} finally {
			await server.close();
		}
	});

	it("announces keyless mode instead of an empty bearer token", async () => {
		const server = await startMockTavilyServer(() => json({ results: [] }));
		try {
			await withEnv(KEYLESS_ENV, async () => {
				const client = createTavilyClient({ apiBaseURL: server.baseUrl });
				const result = await tavilySearch(client, { query: "hello" });
				expect(result.ok).toBe(true);
			});
			const request = server.lastRequest();
			expect(request?.headers["x-tavily-access-mode"]).toBe("keyless");
			expect(request?.headers.authorization).toBeUndefined();
			expect(request?.headers["x-client-source"]).toBe("omp");
		} finally {
			await server.close();
		}
	});

	it("omits identity headers the caller did not set", async () => {
		const server = await startMockTavilyServer(() => json({ results: [] }));
		try {
			await withEnv({ ...KEYLESS_ENV, TAVILY_API_KEY: "sk-test" }, async () => {
				await tavilySearch(createTavilyClient({ apiBaseURL: server.baseUrl }), { query: "hello" });
			});
			const request = server.lastRequest();
			expect(request?.headers["x-session-id"]).toBeUndefined();
			expect(request?.headers["x-human-id"]).toBeUndefined();
			expect(request?.headers["x-project-id"]).toBeUndefined();
			expect(request?.headers["x-tavily-orgid"]).toBeUndefined();
		} finally {
			await server.close();
		}
	});
});
