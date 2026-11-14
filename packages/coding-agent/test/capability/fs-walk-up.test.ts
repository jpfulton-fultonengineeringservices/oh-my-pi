import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, walkUp, walkUpSync } from "@oh-my-pi/pi-coding-agent/capability/fs";

const ABSENT = "omp-walkup-target-absent-zxqv7k";

describe("capability/fs walkUpSync", () => {
	let root = "";
	let leaf = "";

	beforeAll(async () => {
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-walkup-"));
		leaf = path.join(root, "a", "b", "c");
		await fs.promises.mkdir(leaf, { recursive: true });
		await fs.promises.writeFile(path.join(root, "config.yml"), "codekeeper:\n  apiUrl: x\n");
		await fs.promises.mkdir(path.join(root, "skills"));
	});

	afterAll(async () => {
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	it("finds an ancestor's file from a deep descendant", () => {
		clearCache();
		expect(walkUpSync(leaf, "config.yml", { file: true })).toBe(path.join(root, "config.yml"));
	});

	it("applies the entry-kind options to the found entry", () => {
		clearCache();
		expect(walkUpSync(leaf, "skills", { dir: true })).toBe(path.join(root, "skills"));
		expect(walkUpSync(leaf, "skills", { file: true, dir: false })).toBeNull();
		expect(walkUpSync(leaf, "config.yml", { file: false, dir: true })).toBeNull();
	});

	it("agrees with the asynchronous walk, hit and miss alike", async () => {
		clearCache();
		expect(walkUpSync(leaf, "config.yml")).toBe(await walkUp(leaf, "config.yml"));
		clearCache();
		expect(walkUpSync(leaf, ABSENT)).toBe(await walkUp(leaf, ABSENT));
	});

	it("returns null when no ancestor carries the name", () => {
		clearCache();
		expect(walkUpSync(leaf, ABSENT)).toBeNull();
	});

	it("reads through the same directory cache as the asynchronous walk", async () => {
		const marker = path.join(root, "shared-marker.txt");
		await fs.promises.writeFile(marker, "x");
		clearCache();
		expect(await walkUp(leaf, "shared-marker.txt")).toBe(marker);

		// Deleted from disk but still in the cache the async walk filled.
		await fs.promises.rm(marker);
		expect(walkUpSync(leaf, "shared-marker.txt")).toBe(marker);

		clearCache();
		expect(walkUpSync(leaf, "shared-marker.txt")).toBeNull();
	});
});
