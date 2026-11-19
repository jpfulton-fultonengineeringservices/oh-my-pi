/**
 * Regression tests for the `retain` result text: the ids the backend assigned must
 * reach the model, not only the renderer.
 *
 * `retain` used to answer "2 memories stored." and drop the ids it had collected, so
 * the agent had to `memory_list` the store and guess which row it had just written
 * before it could `memory_edit` it. The ids are the handle, so the tool reports them
 * per item. Each arm here therefore asserts the exact text the model sees, for the
 * single-item and the batch shape, on the backend that answers a write with an id
 * (`memvidkb`, stubbed in-process with `Bun.serve` the way `test/memvidkb-backend.test.ts`
 * stubs it) and on the one that returns them synchronously (`mnemopi`, with a hand-rolled
 * session state so the arm needs no native module).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { retainToolRenderer } from "@oh-my-pi/pi-tui/tools/memory";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText, TempDir } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

const TOKEN = "kb-retain-ids-test-bearer";
const TOKEN_ENV = "MEMVIDKB_RETAIN_IDS_TEST_TOKEN";

type Recorded = { method: string; path: string; search: string; body: string };
type ResultText = { content: Array<{ type: string; text?: string }>; details?: unknown };

let temp: TempDir;
let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];
let realAgentDir: string;

/** A `RememberResponse` for the nth write; the id is the whole point of the fixture. */
function recordBody(index: number): Record<string, unknown> {
	const id = `rec-${String(index + 1)}`;
	return {
		id,
		uri: `mv2://dev/${id}`,
		frameId: `frame-${String(index + 1)}`,
		track: "dev",
		title: null,
		tags: [],
		originActor: "fulton",
		capturedAt: "2026-11-18T04:00:00Z",
		derivedFrom: null,
	};
}

async function writeConfig(): Promise<void> {
	const doc = {
		version: 1,
		context: "fulton",
		baseUrl: `${baseUrl}/`,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["dev", "notes"],
		remember: "on",
	};
	await Bun.write(`${temp.path()}/.memvidkb`, JSON.stringify(doc));
}

function makeSession(settings: Settings, mnemopiState?: unknown): ToolSession {
	return {
		cwd: temp.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => "retain-ids-test-session",
		getSessionSpawns: () => null,
		sessionManager: { getCwd: () => temp.path(), getEntries: () => [] },
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: mnemopiState === undefined ? () => undefined : () => mnemopiState,
	} as unknown as ToolSession;
}

/**
 * The mnemopi surface `retain` actually touches: a synchronous `rememberScoped` that
 * hands back the id the caller will read, plus the session fields the metadata carries.
 */
function mnemopiState(ids: readonly string[]): { written: string[] } {
	const written: string[] = [];
	return {
		written,
		sessionId: "retain-ids-test-session",
		session: { sessionManager: { getCwd: () => temp.path() } },
		rememberScoped: (content: string): string => {
			written.push(content);
			return ids[written.length - 1] ?? "";
		},
	} as unknown as { written: string[] };
}

function textOf(result: ResultText): string {
	const first = result.content[0];
	return first?.text ?? "";
}

/** A retain tool wired to a mnemopi state that hands back the given ids in order. */
function mnemopiTool(ids: readonly string[]): { tool: MemoryRetainTool; state: { written: string[] } } {
	const state = mnemopiState(ids);
	const settings = Settings.isolated({ "memory.backend": "mnemopi" });
	const instance = MemoryRetainTool.createIf(makeSession(settings, state));
	if (!instance) throw new Error("mnemopi backend did not mount the retain tool");
	return { tool: instance, state };
}

beforeEach(async () => {
	resetSettingsForTest();
	temp = TempDir.createSync("@memvidkb-retain-ids-test-");
	requests = [];
	realAgentDir = getAgentDir();
	setAgentDir(temp.path());
	process.env[TOKEN_ENV] = TOKEN;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const recorded: Recorded = {
				method: request.method,
				path: url.pathname,
				search: url.search,
				body: await request.text(),
			};
			const index = requests.length;
			requests.push(recorded);
			if (recorded.path === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
			if (recorded.path.endsWith("/records") && recorded.method === "POST") return Response.json(recordBody(index));
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
	await writeConfig();
});

afterEach(() => {
	server.stop(true);
	delete process.env[TOKEN_ENV];
	setAgentDir(realAgentDir);
	resetSettingsForTest();
	temp.removeSync();
});

describe("retain result carries the stored ids (memvidkb)", () => {
	function tool(settings?: Settings): MemoryRetainTool {
		const isolated = settings ?? Settings.isolated({ "memory.backend": "memvidkb" });
		const instance = MemoryRetainTool.createIf(makeSession(isolated));
		if (!instance) throw new Error("memvidkb backend did not mount the retain tool");
		return instance;
	}

	it("names the id it assigned when one item is stored", async () => {
		const result = await tool().execute("call-retain-kb-single", {
			items: [{ content: "Roll the gateway before the router.", context: "deploy order" }],
		});

		expect(textOf(result)).toBe("1 memory stored. id=rec-1");
		expect(result.details).toEqual({ count: 1, ids: ["rec-1"] });
		expect(requests.filter(record => record.method === "POST")).toHaveLength(1);
	});

	it("maps each id to its own item, in the caller's order, for a batch", async () => {
		const result = await tool().execute("call-retain-kb-batch", {
			items: [
				{ content: "Roll the gateway before the router." },
				{ content: "The health probe is the first line of the deploy log." },
			],
		});

		expect(textOf(result)).toBe(["2 memories stored.", "item 1 (id rec-1)", "item 2 (id rec-2)"].join("\n"));
		expect(result.details).toEqual({ count: 2, ids: ["rec-1", "rec-2"] });
		expect(requests.filter(record => record.method === "POST")).toHaveLength(2);
	});
});

describe("retain result carries the stored ids (mnemopi)", () => {
	it("names the id the backend returned for a single item", async () => {
		const { tool: retain, state } = mnemopiTool(["mem-7"]);
		const result = await retain.execute("call-retain-mnemopi-single", {
			items: [{ content: "The user prefers tabs over spaces." }],
		});

		expect(textOf(result)).toBe("1 memory stored. id=mem-7");
		expect(result.details).toEqual({ count: 1, ids: ["mem-7"] });
		expect(state.written).toEqual(["The user prefers tabs over spaces."]);
	});

	it("pairs each returned id with the item that produced it", async () => {
		const { tool: retain } = mnemopiTool(["mem-8", "mem-9", "mem-10"]);
		const result = await retain.execute("call-retain-mnemopi-batch", {
			items: [{ content: "fact one" }, { content: "fact two" }, { content: "fact three" }],
		});

		expect(textOf(result)).toBe(
			["3 memories stored.", "item 1 (id mem-8)", "item 2 (id mem-9)", "item 3 (id mem-10)"].join("\n"),
		);
		expect(result.details).toEqual({ count: 3, ids: ["mem-8", "mem-9", "mem-10"] });
	});
});

/**
 * The renderer pairs an id with the content it names by the item's own index. A blank
 * item is stored and holds an id but renders nothing, so pairing by rendered position
 * would print item 3's handle beside item 2 — the same wrong-handle harm D2 set out to
 * remove, moved from the model's text into the transcript. `memvidkb` refuses blank
 * content before it is ever written, so this reaches the store through the mnemopi
 * path, whose `rememberScoped` accepts what it is handed.
 */
describe("retain renderer pairs each id with the item it names", () => {
	it("keeps a blank item from sliding a later id onto the wrong content", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("the dark theme is unavailable");
		const { tool: retain } = mnemopiTool(["mem-a", "mem-b", "mem-c"]);
		const args = {
			items: [{ content: "first durable fact" }, { content: "   " }, { content: "third durable fact" }],
		};

		const result = await retain.execute("call-retain-mnemopi-blank", args);
		expect(result.details).toEqual({ count: 3, ids: ["mem-a", "mem-b", "mem-c"] });

		const component = retainToolRenderer.renderResult(
			result as never,
			{ expanded: false, isPartial: false } as never,
			theme as never,
			args as never,
		);
		const bullets = sanitizeText(component.render(200).join("\n"))
			.split("\n")
			.filter(line => line.includes(theme.format.bullet));
		expect(bullets).toHaveLength(2);
		expect(bullets[0]).toContain("first durable fact");
		expect(bullets[0]).toContain("id=mem-a");
		expect(bullets[1]).toContain("third durable fact");
		expect(bullets[1]).toContain("id=mem-c");
		expect(bullets[1]).not.toContain("id=mem-b");

		const view = retainToolRenderer.describeResult(result as never, {} as never, args as never) as unknown as {
			body: Array<{ c?: Array<{ p?: { detail?: string } }> }>;
		};
		expect((view.body[0]?.c ?? []).map(node => node.p?.detail)).toEqual(["id=mem-a", "id=mem-c"]);
	});
});
