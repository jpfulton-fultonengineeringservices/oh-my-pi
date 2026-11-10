import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadMemvidkb,
	loadMemvidkbConfig,
	type KnowledgeConfig,
} from "@oh-my-pi/pi-coding-agent/internal-urls/knowledge-config";
import { KnowledgeProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/knowledge-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

const TOKEN_ENV = "MEMVIDKB_TEST_TOKEN";
const TOKEN_VALUE = "test-bearer-token-never-logged";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeConfig(dir: string, config: unknown): Promise<void> {
	await Bun.write(path.join(dir, ".memvidkb"), JSON.stringify(config));
}

/** A consented config with one readable track; callers override the fields under test. */
function config(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
	return {
		version: 1,
		context: "work",
		baseUrl: "http://knowledge.test",
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["notes"],
		remember: "off",
		injectRecall: false,
		recallMaxBytes: 32768,
		startupRecall: [],
		...overrides,
	};
}

function setToken(value: string | undefined): void {
	if (value === undefined) delete process.env[TOKEN_ENV];
	else process.env[TOKEN_ENV] = value;
}

interface FetchCall {
	url: string;
	init?: RequestInit;
}

/** Answer every request from `respond`, recording what was asked for. No real network. */
function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
	const calls: FetchCall[] = [];
	const fetchStub = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const call = { url: String(input), init };
			calls.push(call);
			return respond(call);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub as typeof globalThis.fetch);
	return calls;
}

function authHeader(call: FetchCall | undefined): string | null {
	return new Headers(call?.init?.headers).get("authorization");
}

const RECORD_BODY = {
	id: "doc-1",
	track: "notes",
	uri: "mv2://notes/records/doc-1",
	title: "Release gate notes",
	tags: ["release"],
	text: "Outage is reported unavailable, never zero results.",
	originActor: "alice",
	capturedAt: "2026-11-01T09:00:00Z",
	lastVerifiedAt: "2026-11-09T12:00:00Z",
	derivedFrom: "doc-0",
	supersededBy: "doc-2",
};

describe("knowledge configuration", () => {
	afterEach(() => {
		setToken(undefined);
	});

	it("returns CONFIG_NOT_FOUND for both loaders when no config is found", async () => {
		await withTempDir(async dir => {
			// Stay beyond the ten-directory ancestor search, regardless of host configuration.
			const nested = path.join(dir, ...Array.from({ length: 11 }, (_, i) => `level-${i}`));
			await fs.mkdir(nested, { recursive: true });
			expect(loadMemvidkb(nested)).toMatchObject({ err: { code: "CONFIG_NOT_FOUND" } });
			expect(await loadMemvidkbConfig(nested)).toMatchObject({ err: { code: "CONFIG_NOT_FOUND" } });
		});
	});

	it("loads the nearest ancestor of the supplied cwd, including asynchronously", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			const workspace = path.join(dir, "workspace");
			const nested = path.join(workspace, "nested");
			await fs.mkdir(nested, { recursive: true });
			await writeConfig(dir, config({ context: "outer", baseUrl: "http://outer" }));
			await writeConfig(workspace, config({ baseUrl: "http://workspace" }));
			expect(loadMemvidkb(nested)).toEqual({ ok: config({ baseUrl: "http://workspace" }) });
			expect(await loadMemvidkbConfig(nested)).toEqual({ ok: config({ baseUrl: "http://workspace" }) });
		});
	});

	it("fills in the documented defaults for every optional field", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, { context: "work", baseUrl: "http://knowledge.test", tokenEnvVar: TOKEN_ENV });
			const expected: KnowledgeConfig = {
				version: 1,
				context: "work",
				baseUrl: "http://knowledge.test",
				tokenEnvVar: TOKEN_ENV,
				providers: [],
				tracks: [],
				remember: "off",
				injectRecall: false,
				recallMaxBytes: 32768,
				startupRecall: [],
			};
			expect(loadMemvidkb(dir)).toEqual({ ok: expected });
			expect(await loadMemvidkbConfig(dir)).toEqual({ ok: expected });
		});
	});

	it("rejects malformed JSON and unreadable config files as parse errors", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			const file = path.join(dir, ".memvidkb");
			await Bun.write(file, "{");
			expect(loadMemvidkb(dir)).toMatchObject({ err: { code: "CONFIG_PARSE_ERROR" } });
			expect(await loadMemvidkbConfig(dir)).toMatchObject({ err: { code: "CONFIG_PARSE_ERROR" } });
		});
		await withTempDir(async dir => {
			await fs.mkdir(path.join(dir, ".memvidkb"));
			expect(loadMemvidkb(dir)).toMatchObject({ err: { code: "CONFIG_PARSE_ERROR" } });
			expect(await loadMemvidkbConfig(dir)).toMatchObject({ err: { code: "CONFIG_PARSE_ERROR" } });
		});
	});

	it("rejects configs missing a required field or carrying a wrongly typed one", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			const file = path.join(dir, ".memvidkb");
			for (const value of [
				null,
				[],
				{},
				{ baseUrl: "http://knowledge.test", tokenEnvVar: TOKEN_ENV },
				{ context: "  ", baseUrl: "http://knowledge.test", tokenEnvVar: TOKEN_ENV },
				{ context: "work", tokenEnvVar: TOKEN_ENV },
				{ context: "work", baseUrl: "", tokenEnvVar: TOKEN_ENV },
				{ context: "work", baseUrl: "http://knowledge.test" },
				{ ...config(), tokenEnvVar: 123 },
				{ ...config(), version: 2 },
				{ ...config(), remember: "sometimes" },
				{ ...config(), injectRecall: "yes" },
				{ ...config(), recallMaxBytes: 0 },
				{ ...config(), providers: ["litellm", ""] },
				{ ...config(), tracks: "notes" },
				{ ...config(), startupRecall: [{}] },
			]) {
				await Bun.write(file, JSON.stringify(value));
				expect(loadMemvidkb(dir)).toMatchObject({ err: { code: "INVALID_CONFIG" } });
				expect(await loadMemvidkbConfig(dir)).toMatchObject({ err: { code: "INVALID_CONFIG" } });
			}
		});
	});

	it("reports TOKEN_ENV_UNSET instead of falling back to an unauthenticated config", async () => {
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			for (const value of [undefined, ""]) {
				setToken(value);
				expect(loadMemvidkb(dir)).toMatchObject({ err: { code: "TOKEN_ENV_UNSET" } });
				expect(await loadMemvidkbConfig(dir)).toMatchObject({ err: { code: "TOKEN_ENV_UNSET" } });
			}
			// The bearer value never appears in the message, only the variable name.
			setToken(TOKEN_VALUE);
			expect("ok" in loadMemvidkb(dir)).toBe(true);
			setToken("");
			const refused = loadMemvidkb(dir);
			if (!("err" in refused)) throw new Error("expected an unset-token config error");
			expect(refused.err.msg).toContain(TOKEN_ENV);
			expect(refused.err.msg).not.toContain(TOKEN_VALUE);
		});
	});
});

describe("KnowledgeProtocolHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setToken(undefined);
	});

	it("registers a read-only remote handler in the router", async () => {
		const router = new InternalUrlRouter();
		expect(router.spec("knowledge")).toEqual({ backing: "remote", selectors: "lines", immutable: true });
		await withTempDir(async dir => {
			const resource = await router.resolve("knowledge://track/work/notes", { cwd: dir });
			expect(resource.notes).toEqual(["CONFIG_NOT_FOUND"]);
			expect(resource.content).not.toBe("");
			expect(resource.immutable).toBe(true);
		});
	});

	it("renders a record with a provenance header and notes for the fields actually present", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			const calls = stubFetch(() => Response.json(RECORD_BODY));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://record/work/notes/doc-1"),
				{ cwd: dir },
			);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("http://knowledge.test/memories/notes/records/doc-1");
			expect(authHeader(calls[0])).toBe(`Bearer ${TOKEN_VALUE}`);
			expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);

			expect(resource.url).toBe("knowledge://record/work/notes/doc-1");
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.shape).toBe("document");
			expect(resource.content).toContain("# Release gate notes");
			expect(resource.content).toContain("- id: doc-1");
			expect(resource.content).toContain("- track: notes");
			expect(resource.content).toContain("- origin: alice");
			expect(resource.content).toContain("- captured: 2026-11-01T09:00:00Z");
			expect(resource.content).toContain("- verified: 2026-11-09T12:00:00Z");
			expect(resource.content).toContain("- derived_from: doc-0");
			expect(resource.content).toContain("- superseded_by: doc-2");
			expect(resource.content).toContain("Outage is reported unavailable, never zero results.");
			expect(resource.notes).toEqual([
				"origin=alice",
				"captured=2026-11-01T09:00:00Z",
				"verified_at=2026-11-09T12:00:00Z",
				"derived_from=doc-0",
				"superseded_by=doc-2",
			]);
			expect(resource.isDirectory).toBeUndefined();
		});
	});

	it("omits absent provenance fields from the header and the notes", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			stubFetch(() =>
				Response.json({
					id: "doc-3",
					track: "notes",
					uri: "mv2://notes/records/doc-3",
					title: "Plain note",
					tags: [],
					text: "No provenance recorded.",
					originActor: null,
					capturedAt: null,
					lastVerifiedAt: null,
					derivedFrom: null,
					supersededBy: null,
				}),
			);
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://record/work/notes/doc-3"),
				{ cwd: dir },
			);
			expect(resource.content).toContain("# Plain note");
			expect(resource.content).toContain("No provenance recorded.");
			expect(resource.content).not.toContain("- origin:");
			expect(resource.content).not.toContain("- verified:");
			expect(resource.notes).toEqual([]);
		});
	});

	it("encodes the track and record id when addressing the service", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config({ tracks: ["My Track"] }));
			const calls = stubFetch(() => Response.json({ ...RECORD_BODY, track: "My Track", id: "doc 1" }));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://record/work/My%20Track/doc%201"),
				{ cwd: dir },
			);
			expect(calls[0]?.url).toBe("http://knowledge.test/memories/My%20Track/records/doc%201");
			expect(resource.content).not.toBe("");
		});
	});

	it("lists a track as an addressable directory", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			const calls = stubFetch(() =>
				Response.json({
					track: "notes",
					total: 2,
					limit: 50,
					offset: 0,
					results: [
						{
							id: "doc-1",
							uri: "mv2://notes/records/doc-1",
							title: "Release gate notes",
							tags: ["release"],
							originActor: "alice",
							capturedAt: "2026-11-01T09:00:00Z",
							lastVerifiedAt: null,
							derivedFrom: null,
							supersededBy: null,
							textSnippet: "Outage is reported unavailable.",
						},
						{
							id: "doc-2",
							uri: "mv2://notes/records/doc-2",
							title: null,
							tags: [],
							originActor: null,
							capturedAt: null,
							lastVerifiedAt: null,
							derivedFrom: null,
							supersededBy: null,
							textSnippet: null,
						},
					],
				}),
			);
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://track/work/notes"),
				{ cwd: dir },
			);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("http://knowledge.test/memories/notes/records");
			expect(authHeader(calls[0])).toBe(`Bearer ${TOKEN_VALUE}`);
			expect(resource.isDirectory).toBe(true);
			expect(resource.shape).toBe("document");
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.content).toContain("# Track notes");
			expect(resource.content).toContain("2 of 2 records");
			expect(resource.content).toContain("knowledge://record/work/notes/doc-1");
			expect(resource.content).toContain("Release gate notes");
			expect(resource.content).toContain("Outage is reported unavailable.");
			expect(resource.content).toContain("- doc-2 —");
		});
	});

	it("says so when a permitted track really holds no records", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			stubFetch(() => Response.json({ track: "notes", total: 0, limit: 50, offset: 0, results: [] }));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://track/work/notes"),
				{ cwd: dir },
			);
			expect(resource.isDirectory).toBe(true);
			expect(resource.content).not.toBe("");
			expect(resource.content).toContain("holds no records");
		});
	});

	it("refuses another context before any network call", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			const calls = stubFetch(() => Response.json(RECORD_BODY));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://record/other-context/notes/doc-1"),
				{ cwd: dir },
			);
			expect(calls).toHaveLength(0);
			expect(resource.notes).toEqual(["context_mismatch"]);
			expect(resource.shape).toBe("document");
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.content).toContain("other-context");
			expect(resource.content).toContain("work");
			expect(resource.content).not.toBe("");
		});
	});

	it("refuses a track outside the permitted set before any network call", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config({ tracks: ["notes"] }));
			const calls = stubFetch(() => Response.json(RECORD_BODY));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://record/work/private/secret-doc"),
				{ cwd: dir },
			);
			expect(calls).toHaveLength(0);
			expect(resource.notes).toEqual(["track_not_permitted"]);
			expect(resource.content).toContain("private");
			expect(resource.content).toContain("notes");
			expect(resource.content).not.toBe("");
		});
	});

	it("refuses with no bearer token rather than sending an unauthenticated request", async () => {
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			const calls = stubFetch(() => Response.json(RECORD_BODY));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://track/work/notes"),
				{ cwd: dir },
			);
			expect(calls).toHaveLength(0);
			expect(resource.notes).toEqual(["TOKEN_ENV_UNSET"]);
			expect(resource.content).toContain(TOKEN_ENV);
			expect(resource.content).not.toBe("");
		});
	});

	it("reports a missing config as an explanation, not as empty content", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			const nested = path.join(dir, ...Array.from({ length: 11 }, (_, i) => `level-${i}`));
			await fs.mkdir(nested, { recursive: true });
			const calls = stubFetch(() => Response.json(RECORD_BODY));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://track/work/notes"),
				{ cwd: nested },
			);
			expect(calls).toHaveLength(0);
			expect(resource.notes).toEqual(["CONFIG_NOT_FOUND"]);
			expect(resource.content).not.toBe("");
			expect(resource.shape).toBe("document");
		});
	});

	it("maps every non-200 outcome to its own note with non-empty explanatory content", async () => {
		setToken(TOKEN_VALUE);
		const cases: Array<{ status: number; note: string }> = [
			{ status: 401, note: "unauthorized" },
			{ status: 403, note: "forbidden" },
			{ status: 404, note: "not_found" },
			{ status: 500, note: "service_unavailable" },
		];
		for (const testCase of cases) {
			await withTempDir(async dir => {
				await writeConfig(dir, config());
				stubFetch(
					() =>
						new Response(JSON.stringify({ error: { code: "x", message: `service says ${testCase.status}` } }), {
							status: testCase.status,
							headers: { "content-type": "application/json" },
						}),
				);
				for (const uri of ["knowledge://record/work/notes/doc-1", "knowledge://track/work/notes"]) {
					const resource = await new KnowledgeProtocolHandler().resolve(parseInternalUrl(uri), { cwd: dir });
					expect(resource.notes).toEqual([testCase.note]);
					expect(resource.contentType).toBe("text/markdown");
					expect(resource.shape).toBe("document");
					expect(resource.content).not.toBe("");
					expect(resource.content).toContain(`service says ${testCase.status}`);
					expect(resource.content).not.toContain(TOKEN_VALUE);
				}
			});
		}
	});

	it("reports an unreachable or timing-out service as an outage, never as zero results", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			stubFetch(() => {
				throw new Error("ECONNREFUSED");
			});
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://track/work/notes"),
				{ cwd: dir },
			);
			expect(resource.notes).toEqual(["service_unavailable"]);
			expect(resource.content).toContain("outage");
			expect(resource.content).toContain("ECONNREFUSED");
			expect(resource.content).not.toBe("");
		});
	});

	it("reports a non-JSON success body as an outage", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			stubFetch(() => new Response("<html>proxy</html>", { status: 200 }));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://record/work/notes/doc-1"),
				{ cwd: dir },
			);
			expect(resource.notes).toEqual(["service_unavailable"]);
			expect(resource.content).not.toBe("");
		});
	});

	it("reports a record body without text as an outage", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			stubFetch(() => Response.json({ id: "doc-1", track: "notes" }));
			const resource = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://record/work/notes/doc-1"),
				{ cwd: dir },
			);
			expect(resource.notes).toEqual(["service_unavailable"]);
			expect(resource.content).not.toBe("");
		});
	});

	it("surfaces the caller's abort instead of an outage", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			stubFetch(() => Response.json(RECORD_BODY));
			const controller = new AbortController();
			controller.abort();
			await expect(
				new KnowledgeProtocolHandler().resolve(parseInternalUrl("knowledge://record/work/notes/doc-1"), {
					cwd: dir,
					signal: controller.signal,
				}),
			).rejects.toThrow("aborted");
		});
	});

	it("fails closed for malformed URIs without contacting the service", async () => {
		setToken(TOKEN_VALUE);
		await withTempDir(async dir => {
			await writeConfig(dir, config());
			const calls = stubFetch(() => Response.json(RECORD_BODY));
			for (const uri of [
				"knowledge://unknown/context/track",
				"knowledge://record/context/track",
				"knowledge://track/context/track/document",
				"knowledge://track/context//track",
				"knowledge://track/context/track%2Fother",
				"knowledge://track/context/%ZZ",
			]) {
				const resource = await new KnowledgeProtocolHandler().resolve(parseInternalUrl(uri), { cwd: dir });
				expect(resource.notes).toEqual(["invalid_knowledge_uri"]);
				expect(resource.content).not.toBe("");
			}
			expect(calls).toHaveLength(0);
		});
	});

	it("advertises knowledge:// only when a usable config exists", async () => {
		const handler = new KnowledgeProtocolHandler();
		const cwd = process.cwd();
		try {
			await withTempDir(async dir => {
				process.chdir(dir);
				expect(handler.promptDoc()).toBeUndefined();

				await writeConfig(dir, config());
				// Config alone is not usable: the bearer has to be present too.
				expect(handler.promptDoc()).toBeUndefined();
				setToken(TOKEN_VALUE);
				expect(handler.promptDoc()).toContain("knowledge://record/<context>/<track>/<record-id>");
			});
		} finally {
			process.chdir(cwd);
		}
	});
});
