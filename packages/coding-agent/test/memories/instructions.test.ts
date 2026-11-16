import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-instructions-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

describe("buildMemoryToolDeveloperInstructions", () => {
	it("uses memory:// URLs and does not expose raw memory root paths", async () => {
		await withTempDir(async agentDir => {
			// The summary/skill instructions come from the retained rollout-summary pipeline; `local` is
			// retired from the selector, so this drives the pipeline by naming the id it exercises.
			const settings = Settings.isolated({ "memory.backend": "local" });
			const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "Use structured retries for flaky network calls.");

			const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings.getCwd(), settings);
			expect(instructions).toBeDefined();
			expect(instructions).toContain("memory://root/memory_summary.md");
			expect(instructions).toContain("memory://root/skills/<name>/SKILL.md");
			expect(instructions).not.toContain(memoryRoot);
		});
	});
});
