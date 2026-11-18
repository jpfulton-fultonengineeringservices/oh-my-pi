import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("advisor memory context", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	let tempDir: TempDir;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	const kbServers: Array<{ stop(): void }> = [];

	afterEach(() => {
		while (kbServers.length > 0) kbServers.pop()?.stop();
	});

	/**
	 * Point a workspace at the knowledge service through a real `.memvidkb`, with an
	 * in-process stub answering the health probe (the pattern from
	 * test/sdk-skills.test.ts) so the backend starts without a deployed service.
	 */
	async function writeMemvidkbWorkspaceConfig(cwd: string): Promise<void> {
		const tokenEnv = "OMP_ADVISOR_MEMORY_KB_TOKEN";
		process.env[tokenEnv] = "advisor-memory-test-bearer";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				await request.text();
				if (url.pathname === "/healthz") {
					return new Response("ok", { headers: { "content-type": "text/plain" } });
				}
				return Response.json({
					id: "rec-1",
					uri: "mv2://dev/rec-1",
					frameId: "frame-1",
					track: "dev",
					title: null,
					tags: [],
					originActor: "fulton",
					capturedAt: "2026-11-16T04:00:00Z",
					derivedFrom: null,
				});
			},
		});
		kbServers.push(server);
		await fs.writeFile(
			`${cwd}/.memvidkb`,
			JSON.stringify({
				version: 1,
				context: "fulton",
				baseUrl: `http://127.0.0.1:${server.port}`,
				tokenEnvVar: tokenEnv,
				providers: ["litellm"],
				tracks: ["dev"],
				remember: "on",
			}),
		);
	}

	async function createAdvisedSession(
		backend: string,
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path()),
	): Promise<AgentSession> {
		const settings = Settings.isolated({
			"async.enabled": false,
			"advisor.enabled": true,
			"compaction.enabled": false,
			"memory.backend": backend,
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
		});
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		await settings.reloadForCwd(tempDir.path());
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return result.session;
	}

	it("injects the memvidkb instructions into main and advisor prompts", async () => {
		tempDir = TempDir.createSync("@pi-advisor-memory-");
		await writeMemvidkbWorkspaceConfig(tempDir.path());

		session = await createAdvisedSession("memvidkb");
		// Primary path: the rendered track list lands in the main agent's system prompt.
		expect(session.agent.state.systemPrompt.join("\n")).toContain("`dev`");

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		// Advisor path: the same instructions, wrapped as shared background knowledge.
		const advisorPrompt = advisor.state.systemPrompt.join("\n");
		expect(advisorPrompt).toContain("<memory-context>");
		expect(advisorPrompt).toContain("`dev`");
	});

	it("grants the default advisor roster a recall tool when the backend builds one", async () => {
		tempDir = TempDir.createSync("@pi-advisor-memory-");
		// memvidkb is the only remaining backend that builds the recall tool
		// (MemoryRecallTool.createIf admits memvidkb alongside the retired ids), which is
		// exactly what the advisor roster filter consumes.
		await writeMemvidkbWorkspaceConfig(tempDir.path());
		session = await createAdvisedSession("memvidkb");
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		const names = advisor.state.tools.map(tool => tool.name);
		expect(names).toContain("recall");
		// Default read-only investigative set is unchanged otherwise.
		expect(names).toContain("read");
		expect(names).not.toContain("retain");
		expect(names).not.toContain("edit");
	});

	it("grants no recall tool when the backend builds none", async () => {
		tempDir = TempDir.createSync("@pi-advisor-memory-");
		// `off` stores nothing and builds nothing, so the roster filter must fall back to
		// the plain read-only investigative set.
		session = await createAdvisedSession("off");
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		const names = advisor.state.tools.map(tool => tool.name);
		expect(names).not.toContain("recall");
		expect(names).toContain("read");
	});

	// `memvidkb` keeps the `memory://` surface registered and refuses it as file-backed
	// storage the active backend does not have; `off` never registers the protocol at all.
	it.each([
		{ backend: "memvidkb", refusal: "active backend: memvidkb" },
		{ backend: "off", refusal: "Unknown protocol: memory://" },
	] as const)("keeps in-memory advisor URL tools bound to the $backend session", async ({ backend, refusal }) => {
		tempDir = TempDir.createSync("@pi-advisor-memory-urls-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		try {
			const memoryRoot = getMemoryRoot(tempDir.path(), tempDir.path());
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(`${memoryRoot}/memory_summary.md`, "Advisor project summary marker.\n");

			session = await createAdvisedSession(backend, SessionManager.inMemory(tempDir.path()));
			expect(session.sessionFile).toBeUndefined();
			const advisor = session.getAdvisorAgent();
			if (!advisor) throw new Error("Expected advisor agent to exist");
			const read = advisor.state.tools.find(tool => tool.name === "read");
			const grep = advisor.state.tools.find(tool => tool.name === "grep");
			const glob = advisor.state.tools.find(tool => tool.name === "glob");
			if (!read || !grep || !glob) throw new Error("Expected default advisor URL tools");

			await expect(read.execute("advisor-root-read", { path: "memory://root" })).rejects.toThrow(refusal);
			await expect(
				grep.execute("advisor-root-grep", {
					path: "memory://root",
					pattern: "Advisor project summary marker",
				}),
			).rejects.toThrow(refusal);
			await expect(glob.execute("advisor-root-glob", { path: "memory://root" })).rejects.toThrow(refusal);
			await expect(glob.execute("advisor-root-glob", { path: "memory://root/*.md" })).rejects.toThrow(refusal);

			// Neither remaining backend exposes per-record `memory://` rows (the SQLite rows
			// this half asserted belonged to the retired local store), so the id form must be
			// refused too. The refusal wording is backend-specific; what is pinned is that the
			// call cannot succeed.
			await expect(read.execute("advisor-memory-read", { path: "memory://some-id" })).rejects.toThrow();
		} finally {
			await session?.dispose();
			session = undefined;
			setAgentDir(previousAgentDir);
		}
	});
});
