import { describe, expect, it } from "bun:test";
import { parseYamlConfig, readConfigBlock, stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";

const CONFIG = {
	codekeeper: {
		apiUrl: "http://dell.local:3113",
		apiToken: "ck_live_token",
		timeoutMs: 120000,
		enabled: true,
	},
	modelRoles: {
		judge: "auto/heavy",
		scout: "auto/fast",
	},
	include: ["codekeeper", "memvid"],
} as const;

describe("parseYamlConfig", () => {
	it("reads back what stringifyYamlConfig wrote", () => {
		const text = stringifyYamlConfig(CONFIG);
		expect(parseYamlConfig(text)).toEqual({
			codekeeper: {
				apiUrl: "http://dell.local:3113",
				apiToken: "ck_live_token",
				timeoutMs: 120000,
				enabled: true,
			},
			modelRoles: { judge: "auto/heavy", scout: "auto/fast" },
			include: ["codekeeper", "memvid"],
		});
	});

	it("returns null for an empty or whitespace-only document", () => {
		expect(parseYamlConfig("")).toBeNull();
		expect(parseYamlConfig("\n# only a comment\n  ")).toBeNull();
	});

	it("returns null when the document root is not a mapping", () => {
		expect(parseYamlConfig("- one\n- two\n")).toBeNull();
		expect(parseYamlConfig("just a scalar\n")).toBeNull();
	});

	it("throws on malformed YAML so a broken file is never read as an empty one", () => {
		expect(() => parseYamlConfig("codekeeper:\n\tapiUrl: x\n")).toThrow();
	});
});

describe("readConfigBlock", () => {
	it("returns only the requested section's keys", () => {
		const text = stringifyYamlConfig(CONFIG);
		expect(readConfigBlock(text, "codekeeper")).toEqual({
			apiUrl: "http://dell.local:3113",
			apiToken: "ck_live_token",
			timeoutMs: 120000,
			enabled: true,
		});
	});

	it("returns null for an absent section", () => {
		const text = stringifyYamlConfig(CONFIG);
		expect(readConfigBlock(text, "headroom")).toBeNull();
	});

	it("returns null when the section holds a scalar or a list instead of a mapping", () => {
		expect(readConfigBlock('version: "3"\n', "version")).toBeNull();
		expect(readConfigBlock("include:\n  - one\n  - two\n", "include")).toBeNull();
	});

	it("returns null instead of throwing on malformed YAML", () => {
		expect(readConfigBlock("codekeeper:\n\tapiUrl: x\n", "codekeeper")).toBeNull();
	});
});
