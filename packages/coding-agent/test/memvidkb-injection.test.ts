/**
 * Behaviour contract for the two automatic recall paths of the native `memvidkb` backend:
 * `beforeAgentStartPrompt` and `preCompactionContext`.
 *
 * The service is stubbed in-process with `Bun.serve` exactly as `test/memvidkb-backend.test.ts`
 * does, and the client is never mocked, so every arm here drives real `fetch` traffic through
 * `src/memvidkb/client.ts`. The sessions are fakes exposing only the members the hooks read —
 * `sessionManager.getCwd`/`getSessionFile`, the transcript branch a delivered recall is recorded
 * on (`getBranch`/`appendCustomEntry`), and `agent.state.messages` — which is the same surface
 * `test/hindsight-backend.test.ts` fakes for its own backend.
 *
 * The centre of gravity is the cache-stability freeze. A central knowledge service is written
 * to by other workspaces at arbitrary times, so a running conversation must not see its prompt
 * prefix change underneath a request whose signed thinking is bound to the old one. The arms
 * below pin that in both directions: a frame written after start never enters the conversation
 * that already started, and it does become visible to one that starts afterwards.
 *
 * Two further contracts ride on the same state: an explicit `/memory clear` drops the freeze the
 * way `clearMemoryToolDeveloperInstructionsCache` does for the local engine, and `commit` re-reads
 * conversation ownership instead of trusting that the hook ran again. The recall ceiling is
 * asserted in bytes, because that is the unit `.memvidkb` documents.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { memvidkbBackend } from "../src/memvidkb/backend";
import { resetSettingsForTest, Settings } from "../src/config/settings";

const TOKEN = "kb-injection-test-bearer";
const TOKEN_ENV = "MEMVIDKB_INJECTION_TEST_TOKEN";

/** What the stub's `find` returns until a test re-points it. */
const EARLY_SNIPPET = "Roll the gateway before the router.";
/** What it returns after a test simulates a write landing mid-conversation. */
const LATE_SNIPPET = "FRAME WRITTEN MID FLIGHT";
const SECRET = `ghp_${"A".repeat(36)}`;

type Recorded = { method: string; path: string; body: string };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];
let snippet = EARLY_SNIPPET;
let respond: ((recorded: Recorded) => Response) | undefined;

function findBody(text: string): unknown {
	return {
		query: "q",
		limit: 5,
		offset: 0,
		total: 1,
		mode: "hybrid",
		results: [
			{
				frameId: "frame-0",
				documentId: "mv2://dev/deploy.md",
				uri: "mv2://dev/deploy.md#chunk-0",
				score: 0.75,
				textSnippet: text,
				title: "Deploy",
				timestamp: 1_763_000_000,
			},
		],
	};
}

/** Write a `.memvidkb` naming this stub, with whatever overrides one arm needs. */
async function writeConfigTo(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
	const doc = {
		version: 1,
		context: "fulton",
		baseUrl,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["dev", "notes"],
		remember: "on",
		// Off in the document's own default; the injection arms ask for it explicitly.
		injectRecall: true,
		...overrides,
	};
	await Bun.write(`${dir}/.memvidkb`, JSON.stringify(doc));
}

function dropConfig(dir: string): void {
	rmSync(`${dir}/.memvidkb`, { force: true });
}

/** One entry of a fake transcript; only the fields the recall record uses are modelled. */
interface FakeTranscriptEntry {
	type: string;
	customType?: string;
	data?: unknown;
	role?: string;
}

interface FakeRecallSession {
	agent: { state: { messages: unknown[] } };
	sessionManager: {
		getCwd: () => string;
		getSessionFile: () => string | null;
		getBranch: () => FakeTranscriptEntry[];
		appendCustomEntry: (type: string, data: unknown) => void;
	};
	sessionFile: string | null;
	/** The transcript this fake stands for: the recall record `commit` writes lands here. */
	entries: FakeTranscriptEntry[];
}

/**
 * A session exposing only what the two hooks read. `messages` is mutable so an arm can
 * simulate the first request going out, which is the event the freeze keys on.
 * `getBranch`/`appendCustomEntry` are the transcript half: a delivered recall is recorded there
 * (`../src/memory-backend/recall-entry`), so the fake has a real branch to record into and to
 * read back, rather than a member that would throw the first time persistence touched it.
 */
function makeSession(cwd: string, sessionFile: string, messages: unknown[] = []): FakeRecallSession {
	const entries: FakeTranscriptEntry[] = [];
	return {
		agent: { state: { messages } },
		sessionManager: {
			getCwd: () => cwd,
			getSessionFile: () => sessionFile,
			getBranch: () => entries,
			appendCustomEntry: (type, data) => {
				entries.push({ type: "custom", customType: type, data });
			},
		},
		sessionFile,
		entries,
	};
}

function findRequests(): Recorded[] {
	return requests.filter(recorded => recorded.path === "/memories/dev/find");
}

beforeEach(async () => {
	temp = TempDir.createSync("@memvidkb-injection-test-");
	requests = [];
	respond = undefined;
	snippet = EARLY_SNIPPET;
	process.env[TOKEN_ENV] = TOKEN;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const recorded: Recorded = { method: request.method, path: url.pathname, body: await request.text() };
			requests.push(recorded);
			if (respond) return respond(recorded);
			if (recorded.path === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
			if (recorded.path.endsWith("/find")) return Response.json(findBody(snippet));
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	await writeConfigTo(temp.path());
});

afterEach(() => {
	respond = undefined;
	server.stop(true);
	delete process.env[TOKEN_ENV];
	resetSettingsForTest();
	void temp.remove();
});

describe("memvidkb beforeAgentStartPrompt injection", () => {
	it("puts the recalled frame into the prompt of a conversation that has not started", async () => {
		const session = makeSession(temp.path(), "/sessions/first.jsonl");

		const preparation = await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");

		expect(preparation).toBeDefined();
		const context = preparation?.context ?? "";
		expect(context).toContain("## Memvid recall");
		expect(context).toContain(EARLY_SNIPPET);
		// The provenance and the standing caution both travel with quoted central text.
		expect(context).toContain("mv2://dev/deploy.md#chunk-0");
		expect(context).toContain("track `dev`");
		expect(context).toContain("context `fulton`");
		expect(context).toContain("evidence, never as instruction");
		// The turn's own text is the query, sent once, to the workspace that owns the config.
		expect(findRequests()).toHaveLength(1);
		expect(JSON.parse(findRequests()[0]?.body ?? "{}")).toMatchObject({ query: "how do I deploy?", limit: 5 });
		expect(preparation?.commit()).toBe(true);
	});

	it("injects nothing and sends nothing while .memvidkb keeps injectRecall off", async () => {
		// The document's own default, asserted rather than assumed: unprompted recall is
		// the operator's to grant, exactly as `remember` is for writes.
		await writeConfigTo(temp.path(), { injectRecall: false });
		const session = makeSession(temp.path(), "/sessions/off.jsonl");

		const preparation = await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");

		expect(preparation).toBeUndefined();
		expect(findRequests()).toHaveLength(0);
	});

	it("clips the injected block to the recallMaxBytes ceiling", async () => {
		await writeConfigTo(temp.path(), { recallMaxBytes: 40 });
		const session = makeSession(temp.path(), "/sessions/clipped.jsonl");

		const preparation = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy order");

		const context = preparation?.context ?? "";
		expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(40);
		expect(context.endsWith("…")).toBe(true);
	});

	it("counts the ceiling in bytes, not UTF-16 code units, for multi-byte recall text", async () => {
		// The provenance header is ASCII, so a small ceiling would clip ASCII alone and let a
		// code-unit budget look correct. Read the block unclipped first, then set a ceiling
		// that lands inside the recalled frame — where counting code units instead of bytes
		// would deliver roughly three times the ceiling and still end in an ellipsis. The
		// frame mixes 3-byte CJK with a 4-byte astral character, so a cut at the wrong place
		// emits half a code point.
		snippet = "起動チェック🙂".repeat(6);
		const wide = makeSession(temp.path(), "/sessions/multibyte-wide.jsonl");
		const unclipped = (await memvidkbBackend.beforeAgentStartPrompt(wide as never, "deploy"))?.context ?? "";
		const frameStart = unclipped.indexOf("起");
		expect(frameStart).toBeGreaterThan(0);
		expect(unclipped).toContain("🙂");

		const ceiling = Buffer.byteLength(unclipped.slice(0, frameStart + 5), "utf8") + 3;
		await writeConfigTo(temp.path(), { recallMaxBytes: ceiling });
		const session = makeSession(temp.path(), "/sessions/multibyte.jsonl");

		const context = (await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy"))?.context ?? "";

		expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(ceiling);
		expect(context.endsWith("…")).toBe(true);
		expect(context).toContain("起動");
		// The cut landed on a character boundary: re-encoding reproduces the string exactly,
		// which a slice that split a surrogate pair cannot do.
		expect(Buffer.from(context, "utf8").toString("utf8")).toBe(context);
	});

	it("redacts a secret in recalled text before it reaches the prompt", async () => {
		snippet = `export the token ${SECRET} before deploying`;
		const session = makeSession(temp.path(), "/sessions/redacted.jsonl");

		const preparation = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");

		const context = preparation?.context ?? "";
		expect(context).toContain("[REDACTED]");
		expect(context).not.toContain(SECRET);
	});

	it("keeps a blank prompt from querying the service at all", async () => {
		const session = makeSession(temp.path(), "/sessions/blank.jsonl");

		expect(await memvidkbBackend.beforeAgentStartPrompt(session as never, "   \n\t ")).toBeUndefined();
		expect(findRequests()).toHaveLength(0);
	});

	it("treats an aborted recall as cancelled rather than as a fault or an empty track", async () => {
		const session = makeSession(temp.path(), "/sessions/aborted.jsonl");
		const controller = new AbortController();
		controller.abort();

		expect(
			await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy", controller.signal),
		).toBeUndefined();
	});

	it("freezes nothing on an outage, so the conversation still gets its one read", async () => {
		const session = makeSession(temp.path(), "/sessions/outage.jsonl");
		respond = () => new Response("service exploded", { status: 500 });

		expect(await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy")).toBeUndefined();

		// An outage is not an answer. The conversation has sent nothing yet, so the
		// service coming back must still be able to give it a block.
		respond = undefined;
		const preparation = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(preparation?.context).toContain(EARLY_SNIPPET);
		expect(preparation?.commit()).toBe(true);
	});

	it("reports a lost ownership claim instead of publishing another conversation's freeze", async () => {
		const session = makeSession(temp.path(), "/sessions/ownership.jsonl");
		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(staged).toBeDefined();

		// The same session object resumes a different conversation. The freeze belongs to
		// the transcript that captured it, so the new conversation gets its own read and the
		// undelivered preparation from the old one owns nothing it may still publish.
		session.sessionManager.getSessionFile = () => "/sessions/other.jsonl";
		const replacement = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(replacement?.context).toContain(EARLY_SNIPPET);

		// Stale first, current second — and in that order, so the rejection is about
		// ownership and not about a block having been delivered.
		expect(staged?.commit()).toBe(false);
		expect(replacement?.commit()).toBe(true);
		expect(findRequests()).toHaveLength(2);

		// A third pass on the now-current conversation adds nothing of its own.
		expect(await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy")).toBeUndefined();
	});

	it("refuses to commit once the session moved on without another recall", async () => {
		const session = makeSession(temp.path(), "/sessions/detached.jsonl");
		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(staged?.context).toContain(EARLY_SNIPPET);

		// The transcript changes under the session and no further recall happens, so the
		// lazy eviction inside `beforeAgentStartPrompt` never runs. Commit has to re-read the
		// conversation key itself rather than trust that the hook was called again.
		session.sessionManager.getSessionFile = () => "/sessions/detached-later.jsonl";

		expect(staged?.commit()).toBe(false);
		expect(findRequests()).toHaveLength(1);
	});

	it("commits repeatedly while the session still owns the conversation", async () => {
		const session = makeSession(temp.path(), "/sessions/repeat-commit.jsonl");
		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(staged?.context).toContain(EARLY_SNIPPET);

		// Pinned deliberately: repeating a report that already succeeded is not a loss of
		// ownership, as in mnemopi's generation-gated `#commitRecall`. `session-tools.ts`
		// composes this commit with a refresh commit on the same delivery path, and reading a
		// benign repeat as a failure would throw away a block that was actually delivered.
		expect(staged?.commit()).toBe(true);
		expect(staged?.commit()).toBe(true);
		expect(await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy again")).toBeUndefined();
	});
});

describe("memvidkb recall freeze (cache stability)", () => {
	it("delivers the block once and never re-reads or re-appends it", async () => {
		const session = makeSession(temp.path(), "/sessions/once.jsonl");

		const first = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(first?.context).toContain(EARLY_SNIPPET);
		expect(first?.commit()).toBe(true);

		expect(await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy again")).toBeUndefined();
		expect(findRequests()).toHaveLength(1);
	});

	it("re-delivers the frozen block verbatim when a delivery is lost, without re-reading", async () => {
		const session = makeSession(temp.path(), "/sessions/lost.jsonl");

		const first = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(first?.context).toContain(EARLY_SNIPPET);

		// A frame lands in the track; the undelivered preparation must still hand back
		// the bytes the conversation froze to, not whatever the service says now.
		snippet = LATE_SNIPPET;
		const second = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(second?.context).toBe(first?.context);
		expect(second?.context).not.toContain(LATE_SNIPPET);
		expect(findRequests()).toHaveLength(1);
		expect(second?.commit()).toBe(true);
	});

	it("keeps a frame written after start out of the started conversation and shows it to a new one", async () => {
		const first = makeSession(temp.path(), "/sessions/a.jsonl");

		const earlyPreparation = await memvidkbBackend.beforeAgentStartPrompt(first as never, "deploy");
		expect(earlyPreparation?.context).toContain(EARLY_SNIPPET);
		expect(earlyPreparation?.commit()).toBe(true);

		// The conversation has begun: a request went out bound to the prompt it carried.
		first.agent.state.messages.push({ role: "user", content: "deploy?", timestamp: 0 });
		// And the central track moved on underneath it.
		snippet = LATE_SNIPPET;

		// (a) Its own later turns get nothing further.
		expect(await memvidkbBackend.beforeAgentStartPrompt(first as never, "and now?")).toBeUndefined();
		// (b) Nor does any session entering the already-started conversation adopt the new
		// frame — this is the mid-flight adoption the freeze exists to stop.
		const joined = makeSession(temp.path(), "/sessions/a.jsonl", first.agent.state.messages);
		expect(await memvidkbBackend.beforeAgentStartPrompt(joined as never, "and now?")).toBeUndefined();
		// (c) The service was queried exactly once for this conversation.
		expect(findRequests()).toHaveLength(1);

		// (d) A conversation that starts after the write does see it.
		const fresh = makeSession(temp.path(), "/sessions/b.jsonl");
		const latePreparation = await memvidkbBackend.beforeAgentStartPrompt(fresh as never, "deploy");
		expect(latePreparation?.context).toContain(LATE_SNIPPET);
		expect(latePreparation?.context).not.toContain(EARLY_SNIPPET);
		expect(latePreparation?.commit()).toBe(true);
		expect(findRequests()).toHaveLength(2);
	});

	it("refuses a first block outright to a conversation that already holds a message", async () => {
		// The strongest arm of the guard: no freeze existed, the service has an answer,
		// and the conversation still gets nothing because a request already went out.
		const started = makeSession(temp.path(), "/sessions/late-entry.jsonl", [
			{ role: "user", content: "already asked", timestamp: 0 },
		]);

		expect(await memvidkbBackend.beforeAgentStartPrompt(started as never, "and now?")).toBeUndefined();
		expect(findRequests()).toHaveLength(0);
	});
});

describe("memvidkb preCompactionContext", () => {
	const USER_TURN = "what did we decide about the deploy order?";
	const messages = [{ role: "user", content: USER_TURN, timestamp: 0 }] as never[];

	it("grounds the summarization prompt in the recalled frames", async () => {
		const session = makeSession(temp.path(), "/sessions/compact.jsonl");

		const context = await memvidkbBackend.preCompactionContext(messages, Settings.isolated(), session as never);

		expect(context).toContain("## Memvid recall");
		expect(context).toContain(EARLY_SNIPPET);
		expect(findRequests()).toHaveLength(1);
		// The query is the last user turn of the region being discarded.
		expect(JSON.parse(findRequests()[0]?.body ?? "{}")).toMatchObject({ query: USER_TURN, limit: 5 });
	});

	it("injects nothing and sends nothing when given no session", async () => {
		// The witness that the endpoint is resolved from the session alone. A decoy config
		// that `settings.getCwd()` would find is planted on purpose: were the resolver to
		// fall back to settings, this arm would reach the service with this conversation's
		// text under a credential the real project never granted.
		const decoy = TempDir.createSync("@memvidkb-injection-decoy-");
		try {
			await writeConfigTo(decoy.path());
			const settings = Settings.isolated();
			settings.getCwd = () => decoy.path();

			const context = await memvidkbBackend.preCompactionContext(messages, settings);

			expect(context).toBeUndefined();
			expect(findRequests()).toHaveLength(0);
		} finally {
			void decoy.remove();
		}
	});

	it("injects nothing when the region holds no user turn", async () => {
		const session = makeSession(temp.path(), "/sessions/no-user.jsonl");
		const assistantOnly = [
			{ role: "assistant", content: [{ type: "text", text: "we roll the gateway" }] },
		] as never[];

		expect(
			await memvidkbBackend.preCompactionContext(assistantOnly, Settings.isolated(), session as never),
		).toBeUndefined();
		expect(findRequests()).toHaveLength(0);
	});

	it("injects nothing when the service fails, without throwing", async () => {
		const session = makeSession(temp.path(), "/sessions/fail.jsonl");
		respond = () => new Response("service exploded", { status: 500 });

		expect(
			await memvidkbBackend.preCompactionContext(messages, Settings.isolated(), session as never),
		).toBeUndefined();
	});

	it("joins the text blocks of a content-array user turn into the query", async () => {
		const session = makeSession(temp.path(), "/sessions/blocks.jsonl");
		const blockMessages = [
			{ role: "assistant", content: [{ type: "text", text: "not this one" }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "first part" },
					{ type: "image", data: "ignore", mimeType: "image/png" },
					{ type: "text", text: "second part" },
				],
			},
		] as never[];

		await memvidkbBackend.preCompactionContext(blockMessages, Settings.isolated(), session as never);

		expect(JSON.parse(findRequests()[0]?.body ?? "{}")).toMatchObject({ query: "first part\nsecond part" });
	});

	it("stays inert when the config is gone, exactly as the sibling reads do", async () => {
		dropConfig(temp.path());
		const session = makeSession(temp.path(), "/sessions/no-config.jsonl");

		expect(
			await memvidkbBackend.preCompactionContext(messages, Settings.isolated(), session as never),
		).toBeUndefined();
		expect(await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy")).toBeUndefined();
		expect(findRequests()).toHaveLength(0);
	});
});

describe("memvidkb clear (explicit /memory clear)", () => {
	it("drops a staged block so it cannot be appended after the clear", async () => {
		const session = makeSession(temp.path(), "/sessions/cleared.jsonl");
		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(staged?.context).toContain(EARLY_SNIPPET);

		// The central track is refused, not wiped, but whatever this backend had already
		// staged for this conversation must not survive an explicit clear. A conversation
		// that has sent nothing yet is entitled to its own fresh read.
		snippet = LATE_SNIPPET;
		await memvidkbBackend.clear(temp.path(), temp.path(), session as never);

		const replacement = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(replacement?.context).toContain(LATE_SNIPPET);
		expect(replacement?.context).not.toContain(EARLY_SNIPPET);
		expect(staged?.commit()).toBe(false);
		expect(findRequests()).toHaveLength(2);
	});

	it("does not hand a started conversation a fresh block it never froze to", async () => {
		const session = makeSession(temp.path(), "/sessions/cleared-started.jsonl");
		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy");
		expect(staged?.commit()).toBe(true);
		session.agent.state.messages.push({ role: "user", content: "deploy?", timestamp: 0 });

		await memvidkbBackend.clear(temp.path(), temp.path(), session as never);
		snippet = LATE_SNIPPET;

		// Dropping the freeze must not become a loophole past the freeze: a conversation
		// whose first request already went out still cannot adopt a block mid-flight, and
		// the clear alone must not cost it a request.
		expect(await memvidkbBackend.beforeAgentStartPrompt(session as never, "and now?")).toBeUndefined();
		expect(findRequests()).toHaveLength(1);
	});

	it("leaves other conversations frozen to what they adopted", async () => {
		const cleared = makeSession(temp.path(), "/sessions/two-cleared.jsonl");
		const kept = makeSession(temp.path(), "/sessions/two-kept.jsonl");
		const first = await memvidkbBackend.beforeAgentStartPrompt(cleared as never, "deploy");
		const second = await memvidkbBackend.beforeAgentStartPrompt(kept as never, "deploy");
		expect(first?.context).toContain(EARLY_SNIPPET);
		expect(second?.context).toContain(EARLY_SNIPPET);

		// Clearing is addressed to one conversation, the way the local engine's cache drop
		// is; a bystander's prompt prefix must not change under it.
		await memvidkbBackend.clear(temp.path(), temp.path(), cleared as never);
		snippet = LATE_SNIPPET;

		expect((await memvidkbBackend.beforeAgentStartPrompt(kept as never, "deploy again"))?.context).toBe(
			second?.context,
		);
		expect(second?.commit()).toBe(true);
		expect(findRequests()).toHaveLength(2);
	});
});

/**
 * The operator-facing half of automatic recall. Both injection paths are allowed to be
 * inert — `injectRecall` off is a standing operator choice, and an unbound or track-less
 * binding is a misconfiguration — but they are not allowed to be *silent*: the backend's
 * own contract said the reason "is reported by `status()` and `/memory diagnose`", while
 * neither surface mentioned recall at all. A session then advertised a memory backend that
 * injected nothing, with no way to ask why. These arms pin the named refusal on both.
 */
describe("memvidkb automatic recall refusal reporting", () => {
	it("names the operator's own refusal on status()", async () => {
		await writeConfigTo(temp.path(), { injectRecall: false });

		const status = await memvidkbBackend.status({ cwd: temp.path(), agentDir: temp.path() });

		// The service is healthy and the track is permitted: the only thing missing is
		// consent, and that is what the report has to say.
		expect(status.active).toBe(true);
		expect(status.searchable).toBe(true);
		expect(status.message).toContain("auto recall: off");
		expect(status.message).toContain("injectRecall");
	});

	it("names the operator's own refusal on /memory diagnose", async () => {
		await writeConfigTo(temp.path(), { injectRecall: false });

		const report = await memvidkbBackend.diagnose(temp.path(), temp.path(), undefined as never);

		expect(report).toBeDefined();
		expect(report).toContain("- auto recall: off");
		expect(report).toContain("injectRecall");
		// The model's own verb is unaffected by this gate, and the report says so rather
		// than leaving "no recall" to read as "no memory".
		expect(report).toContain("memory_search");
	});

	it("names a missing default track as the reason on both surfaces", async () => {
		await writeConfigTo(temp.path(), { tracks: [] });

		const status = await memvidkbBackend.status({ cwd: temp.path(), agentDir: temp.path() });
		const report = await memvidkbBackend.diagnose(temp.path(), temp.path(), undefined as never);

		expect(status.message).toContain("auto recall: refused");
		expect(report).toContain("- auto recall: refused");
		// Whatever the framing, it has to carry the reason the selector itself gave — the
		// operator needs the permitted-track list, not a bare "refused".
		expect(status.message).toContain("usable track is permitted");
		expect(report).toContain("usable track is permitted");
	});

	it("reports auto-recall as on when the binding grants it", async () => {
		const status = await memvidkbBackend.status({ cwd: temp.path(), agentDir: temp.path() });
		const report = await memvidkbBackend.diagnose(temp.path(), temp.path(), undefined as never);

		expect(status.active).toBe(true);
		expect(status.message).toContain("auto recall: on");
		expect(report).toContain("- auto recall: on");
	});
});
