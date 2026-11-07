import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadMemvidkb, loadMemvidkbConfig } from "@oh-my-pi/pi-coding-agent/internal-urls/knowledge-config";
import { KnowledgeProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/knowledge-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("knowledge configuration", () => {
	it("returns CONFIG_NOT_FOUND for both loaders when no config is found", async () => {
		await withTempDir(async dir => {
			// Stay beyond the ten-directory ancestor search, regardless of host configuration.
			const nested = path.join(dir, ...Array.from({ length: 11 }, (_, i) => `level-${i}`));
			await fs.mkdir(nested, { recursive: true });
			expect(loadMemvidkb(nested)).toMatchObject({ err: { code: "CONFIG_NOT_FOUND" } });
			expect(await loadMemvidkbConfig(nested)).toMatchObject({ err: { code: "CONFIG_NOT_FOUND" } });
		});
	});

	it("loads the nearest ancestor of the supplied cwd, including asynchronously", async () => {
		await withTempDir(async dir => {
			const workspace = path.join(dir, "workspace");
			const nested = path.join(workspace, "nested");
			await fs.mkdir(nested, { recursive: true });
			await Bun.write(
				path.join(dir, ".memvidkb"),
				JSON.stringify({ baseUrl: "http://outer", tokenEnvVar: "OUTER" }),
			);
			const config = { baseUrl: "http://workspace", tokenEnvVar: "TOKEN" };
			await Bun.write(path.join(workspace, ".memvidkb"), JSON.stringify(config));
			expect(loadMemvidkb(nested)).toEqual({ ok: config });
			expect(await loadMemvidkbConfig(nested)).toEqual({ ok: config });
		});
	});

	it("rejects malformed JSON and incomplete or wrongly typed configs", async () => {
		await withTempDir(async dir => {
			const file = path.join(dir, ".memvidkb");
			await Bun.write(file, "{");
			expect(loadMemvidkb(dir)).toMatchObject({ err: { code: "CONFIG_LOAD_ERROR" } });
			expect(await loadMemvidkbConfig(dir)).toMatchObject({ err: { code: "CONFIG_LOAD_ERROR" } });
			for (const value of [
				null,
				{},
				{ baseUrl: "http://test", tokenEnvVar: 123 },
				{ baseUrl: "", tokenEnvVar: "TOKEN" },
			]) {
				await Bun.write(file, JSON.stringify(value));
				expect(loadMemvidkb(dir)).toMatchObject({ err: { code: "INVALID_CONFIG" } });
				expect(await loadMemvidkbConfig(dir)).toMatchObject({ err: { code: "INVALID_CONFIG" } });
			}
		});
	});

	it("reports config read failures instead of treating them as a missing config", async () => {
		await withTempDir(async dir => {
			await fs.mkdir(path.join(dir, ".memvidkb"));
			expect(loadMemvidkb(dir)).toMatchObject({ err: { code: "CONFIG_LOAD_ERROR" } });
			expect(await loadMemvidkbConfig(dir)).toMatchObject({ err: { code: "CONFIG_LOAD_ERROR" } });
		});
	});
});

describe("KnowledgeProtocolHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers a read-only remote handler in the router", async () => {
		const router = new InternalUrlRouter();
		expect(router.spec("knowledge")).toEqual({ backing: "remote", selectors: "lines", immutable: true });
		const resource = await router.resolve("knowledge://track/context/track");
		expect(resource.notes).toContain("context_unavailable");
		expect(resource.immutable).toBe(true);
	});

	it("fails closed for all well-formed contextual URLs without contacting the service", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const handler = new KnowledgeProtocolHandler();
		for (const uri of [
			"knowledge://record/context/track/document",
			"knowledge://track/context/track",
			"knowledge://track/other-context/track?q=two%20words",
			"knowledge://record/context/My%20Track/doc%201",
		]) {
			const resource = await handler.resolve(parseInternalUrl(uri), { cwd: "/unused" });
			expect(resource.url).toBe(uri);
			expect(resource.notes).toEqual(["service_unavailable", "context_unavailable"]);
			expect(resource.content).toBe("");
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects invalid authorities and paths instead of resolving another resource", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const handler = new KnowledgeProtocolHandler();
		for (const uri of [
			"knowledge://unknown/context/track",
			"knowledge://record/context/track",
			"knowledge://track/context/track/document",
			"knowledge://track/context//track",
			"knowledge://track/context/track%2Fother",
			"knowledge://track/context/%ZZ",
		]) {
			const resource = await handler.resolve(parseInternalUrl(uri));
			expect(resource.notes).toEqual(["invalid_knowledge_uri"]);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
