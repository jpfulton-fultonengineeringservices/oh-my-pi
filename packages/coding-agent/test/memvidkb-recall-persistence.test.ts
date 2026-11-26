/**
 * Durability contract for the native `memvidkb` recall: what a conversation was shown is
 * written into its transcript and replayed from there, not re-derived.
 *
 * The freeze in `test/memvidkb-injection.test.ts` keeps one conversation's prompt prefix
 * stable inside a process. This file pins the half that only matters across a process
 * boundary, which is the whole reason `memory-backend/recall-entry.ts` exists: a resumed
 * session is a new object with no in-memory freeze, so without a persisted recall it asks
 * the service again and can be handed different prompt bytes for a conversation whose
 * signed thinking is already bound to the old ones. Every sibling backend treats it that way
 * (`hindsight/state.ts:519` and `mnemopi/state.ts:754` both read the transcript before they
 * would query, and persist on delivery at `:545`/`:792`); this backend is the one that
 * parsed the config keys and did neither.
 *
 * The service is stubbed in-process with `Bun.serve`, as the injection suite does, and the
 * client is never mocked. "A fresh session" here means a second object over the same
 * transcript entries — the resume case — never the same process's `WeakMap`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { memvidkbBackend } from "../src/memvidkb/backend";
import { cfgMemoryBackend } from "../src/memory-backend/settings";
import { MEMVID_RECALL_HEADING } from "../src/memory-backend/recall-entry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { replayRevivedAgentStart } from "../src/task/executor";

const TOKEN = "kb-recall-persist-test-bearer";
const TOKEN_ENV = "MEMVIDKB_RECALL_PERSIST_TEST_TOKEN";

const EARLY_SNIPPET = "Roll the gateway before the router.";
/** What the stub answers once a test simulates the track moving between sessions. */
const LATE_SNIPPET = "FRAME WRITTEN MID FLIGHT";

type Recorded = { method: string; path: string; body: string };
type TranscriptEntry = { type: string; customType?: string; data?: unknown; role?: string };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];
let snippet = EARLY_SNIPPET;

/**
 * One hit per query, attributed to the query that produced it, so an arm can tell which
 * recall contributed which line. Frame ids are unique per query because the backend merges
 * hits across queries by frame id and a shared id would collapse them.
 */
function findBody(recorded: Recorded): unknown {
	const asked = (JSON.parse(recorded.body) as { query?: string }).query ?? "?";
	const slug = asked.replace(/\W+/g, "-").replace(/^-+|-+$/g, "");
	return {
		query: asked,
		limit: 5,
		offset: 0,
		total: 1,
		mode: "hybrid",
		results: [
			{
				frameId: `frame-${slug}`,
				documentId: "mv2://dev/deploy.md",
				uri: `mv2://dev/deploy.md#${slug}`,
				score: 0.75,
				textSnippet: snippet === EARLY_SNIPPET ? `${EARLY_SNIPPET} [${asked}]` : LATE_SNIPPET,
				title: "Deploy",
				timestamp: 1_763_000_000,
			},
		],
	};
}

async function writeConfigTo(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
	const doc = {
		version: 1,
		context: "fulton",
		baseUrl,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["dev"],
		remember: "on",
		injectRecall: true,
		...overrides,
	};
	await Bun.write(`${dir}/.memvidkb`, JSON.stringify(doc));
}

/**
 * A session over `entries`, the transcript it shares with whatever session object comes
 * next. `getBranch`/`appendCustomEntry` are the two members persistence reads and writes,
 * so a resumed session is modelled by a second object over the same array rather than by a
 * second process.
 */
function makeSession(
	cwd: string,
	sessionFile: string,
	options: { messages?: unknown[]; entries?: TranscriptEntry[] } = {},
): {
	agent: { state: { messages: unknown[] } };
	sessionManager: {
		getCwd: () => string;
		getSessionFile: () => string | null;
		getBranch: () => TranscriptEntry[];
		appendCustomEntry: (type: string, data: unknown) => void;
	};
} {
	const entries = options.entries ?? [];
	const messages = options.messages ?? [];
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
	};
}

/**
 * The turn that carried the block. `findPersistedRecall` only returns a recall a turn
 * followed, and in the real transcript the user message is appended after
 * `before_agent_start` has run, so the delivered block's entry is never the branch's last
 * entry. Modelled here exactly as the siblings leave it.
 */
function deliverTurn(entries: TranscriptEntry[]): void {
	entries.push({ type: "message", role: "user" });
}

/** Settings with the native backend selected, as `resolveMemoryBackend` reads them. */
function memvidkbSettings(): Settings {
	const settings = Settings.isolated();
	cfgMemoryBackend.set(settings, "memvidkb");
	return settings;
}

function findRequests(): Recorded[] {
	return requests.filter(recorded => recorded.path === "/memories/dev/find");
}

function recallEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
	return entries.filter(entry => entry.type === "custom" && entry.customType === "memory_recall");
}

function persistedData(entries: TranscriptEntry[]): Record<string, unknown> | undefined {
	return recallEntries(entries).at(-1)?.data as Record<string, unknown> | undefined;
}

beforeEach(async () => {
	temp = TempDir.createSync("@memvidkb-recall-persist-test-");
	requests = [];
	snippet = EARLY_SNIPPET;
	process.env[TOKEN_ENV] = TOKEN;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const recorded: Recorded = { method: request.method, path: url.pathname, body: await request.text() };
			requests.push(recorded);
			if (recorded.path === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
			if (recorded.path.endsWith("/find")) return Response.json(findBody(recorded));
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	await writeConfigTo(temp.path());
});

afterEach(() => {
	server.stop(true);
	delete process.env[TOKEN_ENV];
	resetSettingsForTest();
	void temp.remove();
});

describe("memvidkb recall persistence", () => {
	it("writes the delivered block into the transcript and replays it byte-identically to a fresh session", async () => {
		// The header of recall-entry.ts promises this exact property: "Keeps a transcript's
		// first-turn memory recall with the transcript." Before this change the block lived
		// only in a WeakMap, so the second session below re-queried and got LATE_SNIPPET.
		const entries: TranscriptEntry[] = [];
		const first = makeSession(temp.path(), "/sessions/recall-persist-resume.jsonl", { entries });

		const staged = await memvidkbBackend.beforeAgentStartPrompt(first as never, "how do I deploy?");
		expect(staged).toBeDefined();
		const delivered = staged?.context ?? "";
		expect(staged?.commit()).toBe(true);
		deliverTurn(entries);
		expect(findRequests()).toHaveLength(1);

		// The track moves while the session is closed.
		snippet = LATE_SNIPPET;

		// A resumed conversation is the same transcript under a new object — the case the
		// in-memory freeze cannot cover, and the reason `persistRecall` exists.
		const resumed = makeSession(temp.path(), "/sessions/recall-persist-resume.jsonl", {
			entries,
			messages: [{ role: "user", content: "and after that?" }],
		});
		const again = await memvidkbBackend.beforeAgentStartPrompt(resumed as never, "and after that?");

		expect(again?.context).toBe(delivered);
		expect(again?.context).not.toContain(LATE_SNIPPET);
		// Replaying is not re-querying: the service was asked once, by the first session.
		expect(findRequests()).toHaveLength(1);
		expect(again?.commit()).toBe(true);
	});

	it("records the delivered block as a memory_recall entry carrying each hit's frame id", async () => {
		const entries: TranscriptEntry[] = [];
		const session = makeSession(temp.path(), "/sessions/recall-persist-ids.jsonl", { entries });

		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");
		expect(staged?.commit()).toBe(true);
		deliverTurn(entries);

		const data = persistedData(entries);
		expect(data).toBeDefined();
		expect(data?.version).toBe(1);
		expect(data?.text).toBe(staged?.context);
		const memories = data?.memories as { id: string; text: string; cut?: true }[];
		expect(memories).toHaveLength(1);
		// The id is the frame the hit came from, which is what makes a replayed block
		// reportable against the service; `find` returns no record id, so nothing else
		// identifies a hit.
		expect(memories[0]?.id).toBe("frame-how-do-I-deploy");
		expect(memories[0]?.text).toContain(EARLY_SNIPPET);
		expect(memories[0]?.cut).toBeUndefined();
	});

	it("marks a memory whose line the byte ceiling cut as clipped, and keeps only its visible text", async () => {
		// The ceiling is derived rather than guessed: the block's header carries the port the
		// stub bound to, so a fixed byte count would stop meaning "clip into the last line"
		// the moment the harness moved. One unclipped read measures the block, and a ceiling a
		// little below that length clips the tail of the final bullet.
		const unclipped = await memvidkbBackend.beforeAgentStartPrompt(
			makeSession(temp.path(), "/sessions/recall-persist-clipped-measure.jsonl") as never,
			"deploy order please",
		);
		const full = unclipped?.context ?? "";
		expect(full.length).toBeGreaterThan(0);
		await writeConfigTo(temp.path(), { recallMaxBytes: full.length - 60 });

		const entries: TranscriptEntry[] = [];
		const session = makeSession(temp.path(), "/sessions/recall-persist-clipped.jsonl", { entries });

		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "deploy order please");
		const delivered = staged?.context ?? "";
		expect(staged?.commit()).toBe(true);
		deliverTurn(entries);

		expect(delivered.endsWith("…")).toBe(true);
		const memories = persistedData(entries)?.memories as { id: string; text: string; cut?: true }[];
		expect(memories.length).toBeGreaterThan(0);
		const last = memories.at(-1);
		expect(last?.cut).toBe(true);
		// What is recorded is what the model saw: the visible prefix, without the ellipsis
		// the clipping added, and never more of the service's text than the prompt carried.
		const shown = `${EARLY_SNIPPET} [deploy order please] (\`mv2://dev/deploy.md#deploy-order-please\`)`;
		const visible = last?.text ?? "";
		expect(visible).not.toContain("…");
		// Exactly a prefix: something was recorded, and nothing past the clip was.
		expect(visible.length).toBeGreaterThan(0);
		expect(shown.startsWith(visible)).toBe(true);
		expect(visible.length).toBeLessThan(shown.length);
	});

	it("never writes a recall the transcript did not carry", async () => {
		// Persistence belongs to the success arm of `commit`: a staged block whose turn was
		// cancelled must not become the bytes a later resume replays as though delivered.
		const entries: TranscriptEntry[] = [];
		const session = makeSession(temp.path(), "/sessions/recall-persist-undelivered.jsonl", { entries });

		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");
		expect(staged).toBeDefined();

		expect(recallEntries(entries)).toHaveLength(0);
		expect(persistedData(entries)).toBeUndefined();

		// And a commit that is *refused* is as silent as a turn that never came: the transcript
		// moved out from under the staged block, so the model never held this block either.
		session.sessionManager.getSessionFile = () => "/sessions/recall-persist-undelivered-moved.jsonl";
		expect(staged?.commit()).toBe(false);
		expect(persistedData(entries)).toBeUndefined();
	});

	it("does not resurrect a recall block that an explicit /memory clear dropped", async () => {
		const entries: TranscriptEntry[] = [];
		const first = makeSession(temp.path(), "/sessions/recall-persist-cleared.jsonl", { entries });
		const staged = await memvidkbBackend.beforeAgentStartPrompt(first as never, "how do I deploy?");
		expect(staged?.commit()).toBe(true);
		deliverTurn(entries);
		expect(persistedData(entries)).toBeDefined();

		await memvidkbBackend.clear(temp.path(), temp.path(), first as never);

		// A new turn on the same transcript: the in-memory freeze is gone and the transcript
		// still holds the block, so a restore that consults only the transcript would put
		// the cleared block back on the prompt.
		const next = makeSession(temp.path(), "/sessions/recall-persist-cleared.jsonl", { entries });
		// A new turn on the same transcript carries that transcript's messages: the session
		// object is new, the conversation is not.
		next.agent.state.messages.push({ role: "user", content: "and after that?" });
		const again = await memvidkbBackend.beforeAgentStartPrompt(next as never, "and after that?");

		expect(again).toBeUndefined();
		expect(findRequests()).toHaveLength(1);
	});

	it("recalls the operator's startupRecall queries alongside the turn's own text", async () => {
		// `.memvidkb`'s `startupRecall` names standing queries the conversation opens with.
		// Both other readers of the document honour it (Plane B runs them at `session_start`);
		// the native plane parsed the key and sent nothing, so a documented knob was inert here.
		await writeConfigTo(temp.path(), { startupRecall: ["open questions", "rollback plan"] });
		const entries: TranscriptEntry[] = [];
		const session = makeSession(temp.path(), "/sessions/recall-persist-startup.jsonl", { entries });

		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");

		const queries = findRequests().map(recorded => (JSON.parse(recorded.body) as { query: string }).query);
		expect(queries).toEqual(["how do I deploy?", "open questions", "rollback plan"]);
		const delivered = staged?.context ?? "";
		expect(delivered).toContain("[how do I deploy?]");
		expect(delivered).toContain("[open questions]");
		expect(delivered).toContain("[rollback plan]");
		// One frozen block for one conversation, whatever the number of queries behind it.
		expect(staged?.commit()).toBe(true);
	});

	it("sends no startup query when the document names none", async () => {
		const entries: TranscriptEntry[] = [];
		const session = makeSession(temp.path(), "/sessions/recall-persist-no-startup.jsonl", { entries });

		await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");

		expect(findRequests()).toHaveLength(1);
	});

	it("exposes the block heading as one shared constant, since another repository matches on it", async () => {
		// A wire contract, not a stylistic choice: the config repo's Plane B injector decides
		// whether Plane A already injected by looking for this line
		// (`agents/fulton-omp-config/extensions/lib/knowledge-recall-state.ts`, as
		// `PLANE_A_RECALL_HEADER`). Renaming it here without the matching change there
		// silently re-enables a second injector, which duplicates the block in the prompt.
		expect(MEMVID_RECALL_HEADING).toBe("## Memvid recall");

		const entries: TranscriptEntry[] = [];
		const session = makeSession(temp.path(), "/sessions/recall-persist-heading.jsonl", { entries });
		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");

		expect((staged?.context ?? "").startsWith(`${MEMVID_RECALL_HEADING}\n`)).toBe(true);
	});

	it("hands a revived turn the base prompt with the recall block back in it", async () => {
		// The revive path does not run `beforeAgentStartPrompt`, and the block reaches the base
		// prompt only through the per-turn build a revive skips. A revive handed the bare base
		// prompt, which the config repo's injector reads as "Plane A injected nothing" — it
		// decides whether to run its own injector by looking for this heading. The block is
		// re-staged from the transcript, never re-read: the revived request is bound to the
		// prompt being rebuilt, so a fresh query could put different bytes under it.
		const entries: TranscriptEntry[] = [];
		const session = makeSession(temp.path(), "/sessions/recall-persist-revive.jsonl", { entries });
		const staged = await memvidkbBackend.beforeAgentStartPrompt(session as never, "how do I deploy?");
		expect(staged?.commit()).toBe(true);
		deliverTurn(entries);

		const handed: { base?: readonly string[]; origin?: string } = {};
		const revived = {
			...makeSession(temp.path(), "/sessions/recall-persist-revive.jsonl", { entries }),
			baseSystemPrompt: ["# Subagent", "Tool roster."],
			settings: memvidkbSettings(),
			extensionRunner: {
				emitBeforeAgentStart: async (
					_prompt: string,
					_images: unknown,
					base: readonly string[],
					origin?: string,
				) => {
					handed.base = base;
					handed.origin = origin;
				},
			},
		};

		await replayRevivedAgentStart(revived as never);

		expect(handed.origin).toBe("revive");
		expect(handed.base?.at(-1)).toBe(staged?.context);
		// One query for the whole conversation: the block came back from the transcript.
		expect(findRequests()).toHaveLength(1);
	});

	it("hands a revived turn the base prompt unchanged when the backend declines the recall", async () => {
		// The re-stage is conditional, so a backend that injects nothing must leave the prompt
		// exactly as the harness held it — same array, not a copy with a block added.
		await writeConfigTo(temp.path(), { injectRecall: false });
		const base = ["# Subagent", "Tool roster."];
		const handed: { base?: readonly string[] } = {};
		const revived = {
			...makeSession(temp.path(), "/sessions/recall-persist-revive-off.jsonl"),
			baseSystemPrompt: base,
			settings: memvidkbSettings(),
			extensionRunner: {
				emitBeforeAgentStart: async (_prompt: string, _images: unknown, blocks: readonly string[]) => {
					handed.base = blocks;
				},
			},
		};

		await replayRevivedAgentStart(revived as never);

		expect(handed.base).toBe(base);
	});
});
