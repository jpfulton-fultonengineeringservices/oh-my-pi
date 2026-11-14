import { YAML } from "bun";
import { isRecord } from "./type-guards";

const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

/** Serialize config YAML without Bun's trailing space on block mapping headers. */
export function stringifyYamlConfig(value: unknown): string {
	return YAML.stringify(value, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
}

/**
 * Parse config YAML back into the tree {@link stringifyYamlConfig} wrote, so the
 * file has one reader and one writer. Returns `null` for an empty document or one
 * whose top level is not a mapping (a bare scalar or a sequence); it THROWS when
 * the text is not well-formed YAML, which is how a caller that must distinguish a
 * malformed file from an absent section does so — extension startup code that may
 * not throw on a bad file uses {@link readConfigBlock} instead.
 */
export function parseYamlConfig(text: string): Record<string, unknown> | null {
	if (text.trim() === "") return null;
	const parsed: unknown = YAML.parse(text);
	return isRecord(parsed) ? parsed : null;
}

/**
 * Read one top-level `section:` mapping out of config YAML text, the shape every
 * `~/.omp/agent/config.yml` block reader needs.
 *
 * Never throws: a malformed document, an empty document, an absent section and a
 * section that is not a mapping (a scalar or a list) all read as `null`, so a
 * broken config file costs the caller its defaults and not its session. Callers
 * that must tell "the operator wrote garbage" from "the section is absent" call
 * {@link parseYamlConfig}, which throws on garbage and returns `null` only for the
 * absent/not-a-mapping cases.
 */
export function readConfigBlock(text: string, section: string): Record<string, unknown> | null {
	let parsed: Record<string, unknown> | null;
	try {
		parsed = parseYamlConfig(text);
	} catch {
		return null;
	}
	if (parsed === null) return null;
	return isRecord(parsed[section]) ? parsed[section] : null;
}
