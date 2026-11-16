import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { memvidkbBackend } from "@oh-my-pi/pi-coding-agent/memvidkb/backend";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Guards the two memory-startup branches in createAgentSession (sdk.ts:5845-5856).
// `startMemoryBackend` awaits `resolveMemoryBackend` and then the backend's `start`. A
// top-level auto-learn session awaits that whole promise, so a rejection there fails session
// creation; every other session keeps memory startup off the critical path for the startup
// profile, so the rejection has to surface as a notice instead of an unhandled rejection.
// The rejection is injected at `start` (the only throwing seam left: `memvidkb` resolves, and
// a retired id is refused earlier, by the eager resolve that builds the system prompt).
// Both behaviours are pinned here because the gate cannot tell them apart otherwise.
describe("createAgentSession memory startup failure surface", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	interface CapturedNotice {
		level: string;
		message: string;
		source: string | undefined;
	}

	function noDiscoveryOptions() {
		return {
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-memory-startup-notice-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	/**
	 * The rejection handler that produces the notice is attached inside `createAgentSession`
	 * to a promise the test cannot reach, so there is no signal to await. One macrotask yield
	 * lets every already-queued microtask (the whole rejection chain) run; the assertion is on
	 * the captured notice, never on elapsed time.
	 */
	async function flushQueuedTasks(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	}

	/**
	 * Record every notice emitted during the wrapped call and forward each to the real
	 * implementation, so spying cannot change what the session does with it.
	 */
	async function captureNotices<T>(run: () => Promise<T>): Promise<{ result: T; notices: CapturedNotice[] }> {
		const notices: CapturedNotice[] = [];
		const original = AgentSession.prototype.emitNotice;
		const spy = spyOn(AgentSession.prototype, "emitNotice").mockImplementation(
			function (this: AgentSession, level, message, source) {
				notices.push({ level, message, source });
				original.call(this, level, message, source);
			},
		);
		try {
			const result = await run();
			await flushQueuedTasks();
			return { result, notices };
		} finally {
			spy.mockRestore();
		}
	}

	function memoryError(notices: CapturedNotice[]): CapturedNotice | undefined {
		return notices.find(
			notice =>
				notice.level === "error" && notice.source === "Memory" && notice.message.startsWith("Failed to start the memory backend:"),
		);
	}

	it("notices a failed memory start when it stays off the critical path", async () => {
		const startSpy = spyOn(memvidkbBackend, "start").mockRejectedValue(new Error("injected start failure"));
		try {
			const { result, notices } = await captureNotices(async () => {
				const created = await createAgentSession({
					cwd: registryDir,
					agentDir: registryDir,
					modelRegistry,
					sessionManager: SessionManager.inMemory(),
					// Auto-learn off keeps memory startup in the background, which is where the
					// rejection has to be surfaced rather than awaited.
					settings: Settings.isolated({ "autolearn.enabled": false, "memory.backend": "memvidkb" }),
					model: getBundledModel("openai", "gpt-4o-mini"),
					...noDiscoveryOptions(),
				});
				sessions.push(created.session);
				return created.session;
			});

			// The session itself still starts: a failed memory backend is not fatal here.
			expect(result).toBeInstanceOf(AgentSession);
			const notice = memoryError(notices);
			expect(notice).toBeDefined();
			expect(notice?.message).toContain("injected start failure");
		} finally {
			startSpy.mockRestore();
		}
	});

	it("fails session creation when an auto-learn session cannot start its memory backend", async () => {
		const startSpy = spyOn(memvidkbBackend, "start").mockRejectedValue(new Error("injected start failure"));
		try {
			// The awaiting branch: same setting, opposite outcome, because the rejection is on
			// the critical path instead of a background `.catch`.
			await expect(
				createAgentSession({
					cwd: registryDir,
					agentDir: registryDir,
					modelRegistry,
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({ "autolearn.enabled": true, "memory.backend": "memvidkb" }),
					model: getBundledModel("openai", "gpt-4o-mini"),
					...noDiscoveryOptions(),
				}),
			).rejects.toThrow(/injected start failure/);
		} finally {
			startSpy.mockRestore();
		}
	});

	it("refuses session creation for a retired id whatever the auto-learn setting", async () => {
		const notices: CapturedNotice[] = [];
		const original = AgentSession.prototype.emitNotice;
		const spy = spyOn(AgentSession.prototype, "emitNotice").mockImplementation(
			function (this: AgentSession, level, message, source) {
				notices.push({ level, message, source });
				original.call(this, level, message, source);
			},
		);
		try {
			await expect(
				createAgentSession({
					cwd: registryDir,
					agentDir: registryDir,
					modelRegistry,
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({ "autolearn.enabled": false, "memory.backend": "hindsight" }),
					model: getBundledModel("openai", "gpt-4o-mini"),
					...noDiscoveryOptions(),
				}),
			).rejects.toThrow(/memory\.backend: "hindsight" is retired/);
			await flushQueuedTasks();
		} finally {
			spy.mockRestore();
		}
		// A retired id is refused by the eager resolve that builds the system prompt, so the
		// session never comes up at all — on this branch too, not just the awaited one.
		expect(memoryError(notices)).toBeUndefined();
	});

	it("notices nothing for a backend that resolves", async () => {
		const { notices } = await captureNotices(async () => {
			const created = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "autolearn.enabled": false, "memory.backend": "off" }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				...noDiscoveryOptions(),
			});
			sessions.push(created.session);
			return created.session;
		});
		expect(memoryError(notices)).toBeUndefined();
	});

});
