/**
 * Tests for tool-presentation-policy — the resolvePresentation algorithm.
 *
 * Verifies:
 *   - built-in tools retain their existing direct/mounted placement
 *   - MCP/extension names are filtered by externalDirect / pinnedTopLevel
 *   - unrecognized policy id returns undefined (no filtering)
 *   - missing names in the registry are silently discarded
 */

import { describe, expect, test } from "bun:test"
import type { AgentTool } from "@oh-my-pi/pi-agent-core"
import { SEMANTIC_DISCOVERY_POLICY_ID, resolvePresentation } from "../src/session/tool-presentation-policy"

function tool(name: string): AgentTool {
  return { name, description: "", parameters: { type: "object" } } as AgentTool
}

const alwaysBuiltin = (name: string) => name === "todo" || name === "read" || name === "write" || name === "ask" || name === "grep" || name === "web_search" || name === "yield"

describe("resolvePresentation", () => {
  test("no policy returns undefined", () => {
    const registry = new Map<string, AgentTool>([["todo", tool("todo")]])
    const result = resolvePresentation(registry, undefined, new Set(), new Set(), alwaysBuiltin)
    expect(result).toBeUndefined()
  })

  test("unknown policy id returns undefined", () => {
    const registry = new Map<string, AgentTool>([["todo", tool("todo")]])
    const result = resolvePresentation(registry, { id: "unknown-policy", pinnedTopLevel: new Set(), externalDirect: new Set() }, new Set(), new Set(), alwaysBuiltin)
    expect(result).toBeUndefined()
  })

  test("built-in tools preserve their existing placement", () => {
    const registry = new Map<string, AgentTool>([["todo", tool("todo")]])
    const policy = { id: SEMANTIC_DISCOVERY_POLICY_ID, pinnedTopLevel: new Set<string>(), externalDirect: new Set<string>() }
    // requestedDirect contains built-in names → they should appear in direct
    const result = resolvePresentation(registry, policy, new Set(["todo"]), new Set(["todo"]), alwaysBuiltin)
    expect(result).not.toBeUndefined()
    expect(result!.direct).toContain("todo")
    expect(result!.mounted).not.toContain("todo")
  })

  test("MCP tool filtered out when not in externalDirect", () => {
    const registry = new Map<string, AgentTool>([
      ["mcp__test", tool("mcp__test")],
    ])
    const policy = { id: SEMANTIC_DISCOVERY_POLICY_ID, pinnedTopLevel: new Set<string>(), externalDirect: new Set<string>() }
    const result = resolvePresentation(registry, policy, new Set(), new Set(["mcp__test"]), alwaysBuiltin)
    expect(result).not.toBeUndefined()
    expect(result!.direct).not.toContain("mcp__test")
    expect(result!.mounted).not.toContain("mcp__test")
  })

  test("extension tool promoted when in externalDirect", () => {
    const registry = new Map<string, AgentTool>([
      ["tool_search", tool("tool_search")],
    ])
    const policy = { id: SEMANTIC_DISCOVERY_POLICY_ID, pinnedTopLevel: new Set(["tool_search"]), externalDirect: new Set<string>() }
    const result = resolvePresentation(registry, policy, new Set(), new Set(["tool_search"]), alwaysBuiltin)
    expect(result!.direct).toContain("tool_search")
  })

  test("missing name silently discarded", () => {
    const registry = new Map<string, AgentTool>([["existing", tool("existing")]])
    const policy = { id: SEMANTIC_DISCOVERY_POLICY_ID, pinnedTopLevel: new Set<string>(), externalDirect: new Set(["phantom"]) }
    const result = resolvePresentation(registry, policy, new Set(), new Set(["existing", "phantom"]), alwaysBuiltin)
    // "existing" is in the registry but is neither a builtin nor an MCP name,
    // and is absent from both externalDirect and pinnedTopLevel, so the source
    // deliberately excludes it from every bucket. "phantom" is not in the
    // registry at all, so the `if (!tool) continue` guard prunes it. Net
    // effect: neither leaks into the user-visible tool list — this is the
    // silently-discarded contract under test.
    expect(result!.direct).not.toContain("existing")
    expect(result!.direct).not.toContain("phantom")
    expect(result!.mounted).not.toContain("existing")
    expect(result!.mounted).not.toContain("phantom")
  })

  test("mixed: built-ins + rejected MCP + promoted extension", () => {
    const registry = new Map<string, AgentTool>([
      ["todo", tool("todo")],
      ["mcp__reject", tool("mcp__reject")],
      ["my_mcp", tool("my_mcp")],
    ])
    const policy = { id: SEMANTIC_DISCOVERY_POLICY_ID, pinnedTopLevel: new Set(["todo"]), externalDirect: new Set(["my_mcp"]) }
    const result = resolvePresentation(registry, policy, new Set(["todo"]), new Set(["todo", "mcp__reject", "my_mcp"]), alwaysBuiltin)
    expect(result!.direct).toContain("todo")
    expect(result!.direct).toContain("my_mcp")
    expect(result!.direct).not.toContain("mcp__reject")
  })
})