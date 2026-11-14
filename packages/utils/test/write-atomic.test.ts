import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeAtomic } from "@oh-my-pi/pi-utils/write-atomic";

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-write-atomic-"));
}

describe("writeAtomic", () => {
	it("writes the bytes and creates the parent directories on the way", async () => {
		const dir = await makeTempDir();
		const target = path.join(dir, "nested", "deeper", "state.json");
		await writeAtomic(target, '{"phase":"gated"}');
		expect(await fs.readFile(target, "utf8")).toBe('{"phase":"gated"}');
	});

	it("leaves no staging file behind in the target directory", async () => {
		const dir = await makeTempDir();
		const target = path.join(dir, "worktrees.json");
		await writeAtomic(target, "one");
		expect(await fs.readdir(dir)).toEqual(["worktrees.json"]);
	});

	it("replaces the previous bytes entirely on overwrite", async () => {
		const dir = await makeTempDir();
		const target = path.join(dir, "record.txt");
		await writeAtomic(target, "aaaaaaaaaaaaaaaa");
		await writeAtomic(target, "bb");
		expect(await fs.readFile(target, "utf8")).toBe("bb");
	});

	it("publishes binary data unchanged", async () => {
		const dir = await makeTempDir();
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
		const target = path.join(dir, "blob.bin");
		await writeAtomic(target, bytes);
		expect([...(await fs.readFile(target))]).toEqual([...bytes]);
	});

	it("leaves an existing file untouched and reports the failure when the parent cannot be created", async () => {
		const dir = await makeTempDir();
		const blocker = path.join(dir, "blocker");
		await fs.writeFile(blocker, "not a directory");
		await expect(writeAtomic(path.join(blocker, "child.txt"), "data")).rejects.toThrow();
		expect(await fs.readdir(dir)).toEqual(["blocker"]);
		expect(await fs.readFile(blocker, "utf8")).toBe("not a directory");
	});
});
