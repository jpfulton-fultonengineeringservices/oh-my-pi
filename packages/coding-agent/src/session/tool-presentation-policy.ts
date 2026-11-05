/**
 * Tool presentation policy — semantic tool discovery.
 *
 * An extension-installed policy partitions the enabled tool set into
 * top-level (request-visible) and mounted (`xd://`) subsets deterministically,
 * replacing the stock "everything enabled stays visible" behaviour. Built-in
 * tools are never repartitioned: their existing direct/mounted placement is
 * preserved verbatim. Only MCP and extension tools are subject to filtering —
 * and only the policy's selected set (pinned names plus externally chosen
 * names) stays top-level; every other MCP/extension name is excluded from
 * BOTH the direct list and the mounted list, removing it from prompts, the
 * mount roster and the tool-selection surface entirely.
 *
 * The policy is applied atomically inside `runToolRegistryMutation` by the
 * owning session-tools instance: agent state tools, mounted names and
 * prompt surfaces commit together or roll back together.
 *
 * `resolvePresentation` is a pure function of the tool registry, the
 * policy, and the plain (unfiltered) direct/selected name sets; no state is
 * mutated, no I/O is performed, and no model calls are made. It returns
 * `undefined` when the policy is absent or when its id is unrecognised.
 *
 * See `session-tools.ts#setToolPresentationPolicy` for the install path and
 * `agent-session.ts#applyPolicy` for the selection point.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolInfo } from "../extensibility/extensions";
import { isMCPToolName } from "../tools/builtin-names";

/** Stable identifier for the semantic-discovery policy. Exposed to extensions. */
export const SEMANTIC_DISCOVERY_POLICY_ID = "semantic-tool-discovery";

export interface ToolPresentationPolicy {
	readonly id: typeof SEMANTIC_DISCOVERY_POLICY_ID;
	/** Tools that must stay top-level even while the policy hides everything else. */
	readonly pinnedTopLevel: ReadonlySet<string>;
	/**
	 * MCP/extension tool names the policy chose to expose directly.
	 * Kept in sync by the owning extension whenever its selection changes.
	 */
	readonly externalDirect: ReadonlySet<string>;
}

/**
 * Computes the policy-derived split of a candidate tool set.
 *
 * @param registry The live tool registry (all registered tools, keyed by name).
 * @param policy The active policy, or `undefined` for no active policy.
 * @param requestedDirect Candidate top-level names coming straight from
 *                        `setActiveToolsByName` (plain, unfiltered input).
 * @param requestedEnabled Full requested-enabled set from the same caller.
 * @returns `{ direct, mounted }` when a recognised policy is active, otherwise
 *          `undefined`. Callers MUST fall back to the stock selection when
 *          the returned value is `undefined`.
 *
 * Algorithm outline:
 *  1. `builtin` = names whose entry exists in the registry AND for which
 *     `hasBuiltInTool(name)` is `true` (stock host tool set). Their existing
 *     direct/mounted placement is inherited verbatim — the policy does not
 *     change it.
 *  2. `mcp`    = remaining enabled names satisfying `isMCPToolName(name)`.
 *     Selected (in `externalDirect` ∪ `pinnedTopLevel`) become direct; the rest
 *     become invisible (dropped from BOTH `direct` AND `mounted`).
 *  3. `ext`    = remaining enabled names (extension-contributed, e.g.
 *     `tool_search`). Same rule as MCP: selected names stay direct, all others
 *     disappear.
 *  4. A name present in `requestedEnabled` but missing from the registry is
 *     silently discarded (race-safe prune).
 */
export function resolvePresentation(
	registry: ReadonlyMap<string, AgentTool>,
	policy: ToolPresentationPolicy | undefined,
	requestedDirect: ReadonlySet<string>,
	requestedEnabled: ReadonlySet<string>,
	isBuiltin: (name: string) => boolean,
): { direct: string[]; mounted: string[] } | undefined {
	if (!policy || policy.id !== SEMANTIC_DISCOVERY_POLICY_ID) return undefined;

	const builtinDirect = new Set<string>();
	const builtinMounted = new Set<string>();
	const mcpDirect = new Set<string>();
	const extDirect = new Set<string>();

	for (const name of requestedEnabled) {
		const tool = registry.get(name);
		if (!tool) continue; // stale or never-registered
		if (isBuiltin(name)) {
			// Preserve the existing placement of host built-in tools.
			if (requestedDirect.has(name)) builtinDirect.add(name);
			else builtinMounted.add(name);
		} else if (isMCPToolName(name)) {
			if (policy.externalDirect.has(name) || policy.pinnedTopLevel.has(name)) mcpDirect.add(name);
		} else {
			if (policy.externalDirect.has(name) || policy.pinnedTopLevel.has(name)) extDirect.add(name);
		}
		// unselected MCP/extension names: intentionally excluded from every set.
	}

	return {
		direct: [...builtinDirect, ...mcpDirect, ...extDirect],
		mounted: [...builtinMounted],
	};
}

export type ToolPresentationPolicyResolver = () => ToolPresentationPolicy | undefined;
export type ToolInfoRegistry = { getAllTools: () => ToolInfo[] };
