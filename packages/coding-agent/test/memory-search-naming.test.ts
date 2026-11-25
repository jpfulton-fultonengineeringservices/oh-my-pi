/**
 * Naming contract for the memory tool the gap analysis calls F-17.
 *
 * The verb mounted as `reflect` never spoke the service's synthesis route: the memvidkb
 * branch returns an attributed retrieval page (a "Based on recalled memories:" header over
 * twelve bullets) and the mnemopi branch does local recall plus formatting. A shipped
 * surface therefore named a capability the design corpus's own absence list denies, and its
 * summary advertised synthesis the client refuses to request. The decided remedy (gap
 * analysis §7 Q4) is to rename the mounted tool to what it does — `memory_search` — and to
 * carry the old spelling as a legacy alias so a stored config or session naming `reflect`
 * still resolves.
 *
 * These arms pin the rename from every angle a user or a stored artifact can reach: the
 * mounted name, the name tables that register, gate, and tear it down, the CLI help entry,
 * the read-only-agent predicate, and the legacy alias. They assert nothing about what the
 * tool sends to the service — the rename changes names and strings only.
 */
import { describe, expect, it } from "bun:test";
import {
	BUILTIN_TOOL_HELP,
	BUILTIN_TOOL_NAMES,
	normalizeToolName,
	normalizeToolNames,
} from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { BUILTIN_TOOLS } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MEMORY_BACKEND_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/memory-backend/tool-names";
import { isReadOnlyAgent, READ_ONLY_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/task/read-only-policy";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

/** The only session members the factory and the description getter read. */
function makeSession(mountedNames: readonly string[] = []): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "memory.backend": "memvidkb" }),
		xdev: { mountedNames: new Set(mountedNames) },
	} as unknown as ToolSession;
}

describe("memory_search naming (F-17)", () => {
	it("mounts the verb as memory_search, not reflect", () => {
		const tool = new MemoryReflectTool(makeSession());
		expect(tool.name).toBe("memory_search");
		expect(BUILTIN_TOOL_NAMES).toContain("memory_search");
		expect(BUILTIN_TOOL_NAMES).not.toContain("reflect");
		expect(Object.hasOwn(BUILTIN_TOOLS, "memory_search")).toBe(true);
		expect(Object.hasOwn(BUILTIN_TOOLS, "reflect")).toBe(false);
	});

	it("lists memory_search in the backend-gated tool names so registration and teardown both see it", () => {
		// `MEMORY_BACKEND_TOOL_NAMES` is what `sdk.ts` builds the tool set from, what
		// `session-tools.ts` removes on a backend switch, and what `createTools`
		// force-includes. A name missing here is a tool that can never be mounted —
		// or can never be unmounted.
		expect(MEMORY_BACKEND_TOOL_NAMES).toContain("memory_search");
		expect(MEMORY_BACKEND_TOOL_NAMES).not.toContain("reflect");
	});

	it("treats a session whose only extra tool is memory_search as read-only", () => {
		expect(READ_ONLY_TOOL_NAMES.has("memory_search")).toBe(true);
	});

	it("keeps the pre-rename spelling classified, so a stored definition does not escalate", () => {
		// `isReadOnlyAgent` is fail-safe: an unlisted tool makes the agent not read-only.
		// Agent definitions can arrive from stored or revived state under the name they were
		// written with, and that path is not guaranteed to have run `normalizeToolNames` —
		// so the retired spelling has to stay a member, exactly as `find` stays beside `glob`.
		expect(READ_ONLY_TOOL_NAMES.has("reflect")).toBe(true);
		expect(isReadOnlyAgent({ tools: ["recall", "reflect"] } as never)).toBe(true);
		expect(isReadOnlyAgent({ tools: ["recall", "memory_search"] } as never)).toBe(true);
		// And the set is still fail-safe for a name that was never a memory verb.
		expect(isReadOnlyAgent({ tools: ["recall", "bash"] } as never)).toBe(false);
	});

	it("names the CLI help entry after the tool and describes retrieval, not synthesis", () => {
		const help = BUILTIN_TOOL_HELP.memory_search;
		expect(help).toBeDefined();
		expect(help.summary.toLowerCase()).toContain("memory");
		// The defect this arm exists for: the summary promised an answer the client
		// never asks the service to generate.
		expect(help.summary.toLowerCase()).not.toContain("synthesi");
		expect(Object.hasOwn(BUILTIN_TOOL_HELP, "reflect")).toBe(false);
	});

	it("resolves the old spelling through the legacy alias so stored configs still work", () => {
		// Same pattern as `search -> grep`: the canonical name is the only one tools
		// are keyed on, and the alias keeps a `tools.off: ["reflect"]` entry or an
		// older session's tool list meaningful instead of silently inert.
		expect(normalizeToolName("reflect")).toBe("memory_search");
		expect(normalizeToolName("Reflect")).toBe("memory_search");
		expect(normalizeToolNames(["reflect", "memory_search"])).toEqual(["memory_search"]);
		expect(normalizeToolName("recall")).toBe("recall");
	});

	it("describes the tool as retrieval and points its own reference at the mounted xd:// device", () => {
		const tool = new MemoryReflectTool(makeSession(["memory_search"]));
		const description = tool.description;
		// No claim of a blended or generated answer: that is the sentence the finding
		// is about, and it survived earlier passes as "synthesizes a coherent response".
		expect(description.toLowerCase()).not.toContain("synthesi");
		expect(description.toLowerCase()).not.toContain("blend");
		// The tool must tell the model how to call the verb it is actually mounted as.
		expect(description).toContain("xd://memory_search");
		expect(tool.label.toLowerCase()).toContain("memory");
		expect(tool.summary.toLowerCase()).not.toContain("synthesi");
	});
});
