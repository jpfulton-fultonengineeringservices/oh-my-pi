import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { sharpshooterBankDir } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

describe("sharpshooter memory backend", () => {
	it("injects only populated project decision files", async () => {
		const root = await makeTempDir("sharpshooter-backend");
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const settings = Settings.isolated({
			"memory.backend": "sharpshooter",
			"sharpshooter.injectionTokenLimit": 2400,
		});

		await expect(sharpshooterBackend.buildDeveloperInstructions(agentDir, cwd, settings)).resolves.toBeUndefined();

		const bankDir = sharpshooterBankDir(agentDir, cwd);
		await fs.mkdir(bankDir, { recursive: true });
		await Promise.all([
			Bun.write(path.join(bankDir, "architecture.md"), "- Keep storage project-scoped.\n"),
			Bun.write(path.join(bankDir, "product.md"), "- Prefer explicit user controls.\n"),
			Bun.write(path.join(bankDir, "style.md"), "- Keep output concise.\n"),
		]);

		const instructions = await sharpshooterBackend.buildDeveloperInstructions(agentDir, cwd, settings);
		expect(instructions).toContain("## architecture");
		expect(instructions).toContain("## product");
		expect(instructions).toContain("## style");
	});
});
