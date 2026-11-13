/**
 * Knowledge configuration loader.
 * Loads .memvidkb configuration from the caller's workspace root.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

/** The only `.memvidkb` document version this loader understands. */
const CONFIG_VERSION = 1;
/** Default ceiling on automatically injected recall text. */
const DEFAULT_RECALL_MAX_BYTES = 32768;

export interface KnowledgeConfig {
	/** `.memvidkb` document version; only {@link CONFIG_VERSION} is understood. */
	version: number;
	/** Context NAME this workspace's session is bound to. */
	context: string;
	/** Knowledge service origin, e.g. `http://127.0.0.1:8080`. */
	baseUrl: string;
	/** Name of the env var holding the bearer token — never the token itself. */
	tokenEnvVar: string;
	/** Gateway providers this context is permitted to reach. */
	providers: string[];
	/** Tracks this session is permitted to read. */
	tracks: string[];
	/** Whether explicit remember writes are permitted at all. */
	remember: "off" | "on";
	/** Whether recall is injected automatically. */
	injectRecall: boolean;
	/** Byte ceiling for automatically injected recall. */
	recallMaxBytes: number;
	/** Queries recalled at session startup. */
	startupRecall: string[];
}

export type KnowledgeConfigError = { code: string; msg: string };

export type KnowledgeConfigResult = { ok: KnowledgeConfig } | { err: KnowledgeConfigError };

export async function loadMemvidkbConfig(cwd = process.cwd()): Promise<KnowledgeConfigResult> {
	try {
		const configPath = await findMemvidkbConfigPath(cwd);
		if (!configPath) return { err: configNotFoundError() };

		const configContent = await fsPromises.readFile(configPath, "utf-8");
		return withBearerCheck(toKnowledgeConfig(JSON.parse(configContent) as unknown));
	} catch (error) {
		return { err: configParseError(error) };
	}
}

/** Synchronous version for callers that cannot await configuration loading. */
export function loadMemvidkb(cwd = process.cwd()): KnowledgeConfigResult {
	try {
		const configPath = findMemvidkbConfigPathSync(cwd);
		if (!configPath) return { err: configNotFoundError() };

		const configContent = fs.readFileSync(configPath, "utf-8");
		return withBearerCheck(toKnowledgeConfig(JSON.parse(configContent) as unknown));
	} catch (error) {
		return { err: configParseError(error) };
	}
}

function configNotFoundError(): KnowledgeConfigError {
	return { code: "CONFIG_NOT_FOUND", msg: "No .memvidkb configuration file found in workspace" };
}

function configParseError(error: unknown): KnowledgeConfigError {
	const message = error instanceof Error ? error.message : String(error);
	return { code: "CONFIG_PARSE_ERROR", msg: `Failed to read or parse .memvidkb: ${message}` };
}

/**
 * The bearer token is never stored in `.memvidkb`, only the name of the variable
 * holding it. A missing or empty value is a configuration error: callers must
 * surface it, never fall back to an unauthenticated request.
 */
function withBearerCheck(loaded: KnowledgeConfigResult): KnowledgeConfigResult {
	if ("err" in loaded) return loaded;
	const config = loaded.ok;
	const token = process.env[config.tokenEnvVar];
	if (typeof token !== "string" || token.length === 0) {
		return {
			err: {
				code: "TOKEN_ENV_UNSET",
				msg: `Bearer token env var "${config.tokenEnvVar}" is unset or empty`,
			},
		};
	}
	return { ok: config };
}

function toKnowledgeConfig(value: unknown): KnowledgeConfigResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { err: invalidConfigError("root", "an object") };
	}
	const config = value as Record<string, unknown>;

	for (const field of ["context", "baseUrl", "tokenEnvVar"] as const) {
		if (!isNonEmptyString(config[field])) return { err: invalidConfigError(field, "a non-empty string") };
	}
	if (config.version !== undefined && config.version !== CONFIG_VERSION) {
		return { err: invalidConfigError("version", `the integer ${CONFIG_VERSION}`) };
	}
	for (const field of ["providers", "tracks", "startupRecall"] as const) {
		if (config[field] !== undefined && !isNonEmptyStringArray(config[field])) {
			return { err: invalidConfigError(field, "an array of non-empty strings") };
		}
	}
	if (config.remember !== undefined && config.remember !== "off" && config.remember !== "on") {
		return { err: invalidConfigError("remember", '"off" or "on"') };
	}
	if (config.injectRecall !== undefined && typeof config.injectRecall !== "boolean") {
		return { err: invalidConfigError("injectRecall", "a boolean") };
	}
	if (config.recallMaxBytes !== undefined && !isPositiveInteger(config.recallMaxBytes)) {
		return { err: invalidConfigError("recallMaxBytes", "a positive integer") };
	}

	const context = config.context as string;
	const baseUrl = config.baseUrl as string;
	const tokenEnvVar = config.tokenEnvVar as string;
	return {
		ok: {
			version: CONFIG_VERSION,
			context,
			baseUrl,
			tokenEnvVar,
			providers: (config.providers as string[] | undefined) ?? [],
			tracks: (config.tracks as string[] | undefined) ?? [],
			// Writes are opt-in: an unset `remember` means the operator never granted it.
			remember: (config.remember as "off" | "on" | undefined) ?? "off",
			injectRecall: (config.injectRecall as boolean | undefined) ?? false,
			recallMaxBytes: (config.recallMaxBytes as number | undefined) ?? DEFAULT_RECALL_MAX_BYTES,
			startupRecall: (config.startupRecall as string[] | undefined) ?? [],
		},
	};
}

function invalidConfigError(field: string, expected: string): KnowledgeConfigError {
	return { code: "INVALID_CONFIG", msg: `Knowledge config field "${field}" must be ${expected}` };
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
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

function isMissingPath(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}
