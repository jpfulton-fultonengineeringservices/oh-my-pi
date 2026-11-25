import type { AgentDefinition } from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
//
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"wait",
	"grep",
	"glob",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"ask",
	"todo",
	"recall",
	"memory_search",
	// The verb this one was called before F-17. Stored agent definitions carry the old
	// spelling, and membership here decides the approval tier of a resumed or subagent-revived
	// definition — which is exactly the path that may not have run through
	// `normalizeToolNames`. Dropping it would silently escalate such an agent out of read-only,
	// so it stays, exactly as `find` stays beside `glob`.
	"reflect",
	"retain",
	"memory_edit",
	"memory_list",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}
