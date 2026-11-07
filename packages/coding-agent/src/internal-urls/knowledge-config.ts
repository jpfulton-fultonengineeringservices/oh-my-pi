/**
 * Knowledge configuration loader.
 * Loads .memvidkb configuration from workspace root.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

export interface KnowledgeConfig {
	baseUrl: string;
	tokenEnvVar: string;
}

export async function loadMemvidkbConfig(
	cwd = process.cwd(),
): Promise<{ ok: KnowledgeConfig } | { err: { code: string; msg: string } }> {
	try {
		const configPath = await findMemvidkbConfigPath(cwd);
		if (!configPath) {
			return {
				err: {
					code: "CONFIG_NOT_FOUND",
					msg: "No .memvidkb configuration file found in workspace",
				},
			};
		}

		const configContent = await fsPromises.readFile(configPath, "utf-8");
		const config: unknown = JSON.parse(configContent);
		if (!isKnowledgeConfig(config)) {
			return {
				err: {
					code: "INVALID_CONFIG",
					msg: "Knowledge config missing baseUrl or tokenEnvVar",
				},
			};
		}

		return { ok: config };
	} catch (error) {
		return {
			err: {
				code: "CONFIG_LOAD_ERROR",
				msg: error instanceof Error ? error.message : "Failed to load knowledge config",
			},
		};
	}
}

async function findMemvidkbConfigPath(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);
	const maxDepth = 10;
	let depth = 0;

	while (depth < maxDepth) {
		const configPath = path.join(currentDir, ".memvidkb");
		try {
			await fsPromises.access(configPath);
			return configPath;
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
			depth++;
		}
	}
	return null;
}

/** Synchronous version for callers that cannot await configuration loading. */
export function loadMemvidkb(cwd = process.cwd()): { ok: KnowledgeConfig } | { err: { code: string; msg: string } } {
	try {
		const configPath = findMemvidkbConfigPathSync(cwd);
		if (!configPath) {
			return {
				err: {
					code: "CONFIG_NOT_FOUND",
					msg: "No .memvidkb configuration file found in workspace",
				},
			};
		}

		const configContent = fs.readFileSync(configPath, "utf-8");
		const config: unknown = JSON.parse(configContent);
		if (!isKnowledgeConfig(config)) {
			return {
				err: {
					code: "INVALID_CONFIG",
					msg: "Knowledge config missing baseUrl or tokenEnvVar",
				},
			};
		}

		return { ok: config };
	} catch (error) {
		return {
			err: {
				code: "CONFIG_LOAD_ERROR",
				msg: error instanceof Error ? error.message : "Failed to load knowledge config",
			},
		};
	}
}

function findMemvidkbConfigPathSync(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	const maxDepth = 10;
	let depth = 0;

	while (depth < maxDepth) {
		const configPath = path.join(currentDir, ".memvidkb");
		try {
			fs.accessSync(configPath);
			return configPath;
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
			depth++;
		}
	}
	return null;
}

function isKnowledgeConfig(value: unknown): value is KnowledgeConfig {
	if (typeof value !== "object" || value === null) return false;
	const config = value as Record<string, unknown>;
	return (
		typeof config.baseUrl === "string" &&
		config.baseUrl.length > 0 &&
		typeof config.tokenEnvVar === "string" &&
		config.tokenEnvVar.length > 0
	);
}

function isMissingPath(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}
