import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as hindsightBackend from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { memvidkbBackend } from "@oh-my-pi/pi-coding-agent/memvidkb/backend";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { getProjectAgentDir, getProjectDir, setProjectDir, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		// `Settings.loadIsolated` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
		AgentStorage.close();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		await Bun.write(path.join(cwdB, "moved.txt"), "moved cwd");
		const agentDir = path.join(tempDir, "agent");

		const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "async.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			await sessionManager.moveTo(cwdB);
			expect(sessionManager.getSessionDir().startsWith(`${agentDir}${path.sep}`)).toBe(true);

			// A relative read proves cwd rebinding without creating the process-scoped shell snapshot cache.
			const readTool = session.getToolByName("read");
			if (!readTool) throw new Error("Expected read tool");
			const result = await readTool.execute("read-after-move", { path: "moved.txt" });

			expect(textContent(result)).toContain("moved cwd");
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
	it.each(["hindsight", "mnemopi"] as const)("keeps %s disabled in restricted sessions after /move", async backend => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-restricted-memory-move-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const agentDir = path.join(tempDir, "agent");
		await Promise.all(
			[cwdA, cwdB].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend },
						hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
						mnemopi: { noEmbeddings: true, llmMode: "none" },
					}),
				),
			),
		);
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			restrictToolNames: true,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
		});
		const originalProjectDir = getProjectDir();
		try {
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			const output: string[] = [];
			await executeAcpBuiltinSlashCommand("/move " + cwdB, {
				session,
				sessionManager,
				settings,
				cwd: cwdA,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			});
			expect(output.join("\n")).toContain("Moved to ");
			expect(sessionManager.getCwd()).toBe(cwdB);
			expect(sessionManager.getSessionDir().startsWith(`${agentDir}${path.sep}`)).toBe(true);
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			// Explicit backend reapplication must preserve the same startup policy.
			await session.applyMemoryBackend();
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			setProjectDir(originalProjectDir);
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
	it("applies the destination project's memory backend after /move", async () => {
		// Both projects select `memvidkb` through identical settings and differ only in the
		// per-project `.memvidkb`. The settings reload `/move` performs therefore changes no
		// setting, so it cannot be what builds the destination's memory state: only the cwd
		// rebind can (see the note on `rebindMemoryBackendForCwd`). This pins that wiring for
		// its four production callers — three in `interactive-mode.ts` and this `/move`
		// handler — end to end through the real slash command.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-memory-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		const tokenEnv = "OMP_SDK_MOVE_KB_TOKEN";
		process.env[tokenEnv] = "sdk-move-test-bearer";
		const writeKbConfig = (cwd: string, context: string, track: string) =>
			Bun.write(
				path.join(cwd, ".memvidkb"),
				JSON.stringify({
					version: 1,
					context,
					baseUrl: "http://127.0.0.1:1",
					tokenEnvVar: tokenEnv,
					providers: ["litellm"],
					tracks: [track],
					remember: "on",
					injectRecall: false,
				}),
			);
		await Promise.all([writeKbConfig(cwdA, "context-alpha", "alpha"), writeKbConfig(cwdB, "context-beta", "beta")]);

		const agentDir = path.join(tempDir, "agent");
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
		const authStorage = createInMemoryAuthStorage();
		const originalProjectDir = getProjectDir();
		const startSpy = vi.spyOn(memvidkbBackend, "start");
		let session: AgentSession | undefined;
		let applySpy: ReturnType<typeof vi.spyOn> | undefined;
		let rebindSpy: { mockRestore: () => void } | undefined;
		try {
			({ session } = await createAgentSession({
				cwd: cwdA,
				agentDir,
				sessionManager,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
			}));
			if (!session) throw new Error("Expected a session");
			// Nothing constructs the backend at startup — a settings change can construct one
			// too, so the clean slate here is what makes the post-move call evidence rather
			// than an accident of construction.
			expect(startSpy.mock.calls).toHaveLength(0);
			// `applyMemoryBackend({ retainMnemopi: false })` is the teardown-retention
			// contract: the cwd rebind is the only caller that applies a backend with
			// retention suppressed, and that suppression is what stops the outgoing scope's
			// transcript being captured while the move's own backend rebuild drains it
			// (`session-memory.ts:330`).
			applySpy = vi.spyOn(session, "applyMemoryBackend");
			// The rebind is a module-level function the /move path imports, not a session
			// method, so the arm counts real invocations by wrapping the module export the
			// way the caller sees it. Without this, a spy over the rebind — or a /move path
			// that stopped calling it — would leave every assertion below satisfied while
			// the code under test never ran.
			const hindsightModule = hindsightBackend as {
				rebindMemoryBackendForCwd: (moved: AgentSession) => Promise<void>;
			};
			const originalRebind = hindsightModule.rebindMemoryBackendForCwd;
			let rebindInvocations = 0;
			rebindSpy = vi.spyOn(hindsightModule, "rebindMemoryBackendForCwd").mockImplementation(async moved => {
				rebindInvocations += 1;
				await originalRebind(moved);
			});

			const output: string[] = [];
			await executeAcpBuiltinSlashCommand("/move " + cwdB, {
				session,
				sessionManager,
				settings,
				cwd: cwdA,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			});
			expect(output.join("\n")).toContain("Moved to ");
			expect(sessionManager.getCwd()).toBe(cwdB);
			// Vacuity guard, checked before any other leg: an arm whose rebind never ran
			// must fail loudly rather than pass on effects some other path produced.
			if (rebindInvocations === 0) {
				throw new Error("rebindMemoryBackendForCwd was not invoked by the time the session moved");
			}
			// The move itself must build the destination's backend state — through the
			// destination session, draining the source's writes without capturing the
			// transcript under either transient scope — and not merely report success.
			expect(startSpy.mock.calls.map(call => call[0].session.sessionManager.getCwd())).toContain(cwdB);
			expect(
				applySpy.mock.calls.some((call: [{ retainMnemopi?: boolean }]) => call[0]?.retainMnemopi === false),
			).toBe(true);
			// The state now live is the destination's own knowledge binding.
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain("`beta`");
			expect(prompt).not.toContain("`alpha`");
		} finally {
			rebindSpy?.mockRestore();
			applySpy?.mockRestore();
			startSpy.mockRestore();
			delete process.env[tokenEnv];
			setProjectDir(originalProjectDir);
			if (session) {
				try {
					await session.dispose();
				} finally {
					authStorage.close();
				}
			} else {
				authStorage.close();
			}
		}
	});
});
