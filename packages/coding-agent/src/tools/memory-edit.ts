import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import { memvidkbBackend } from "../memvidkb/backend";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
	"expected_captured_at?": type("string").describe(
		"capturedAt of the row as read back, proof the caller saw it; required by update and forget",
	),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	/**
	 * A knowledge-service edit deletes or rewrites central, shared state, so it carries
	 * the same approval tier as a global retain. Mnemopi edits stay `read`: they mutate
	 * this project's own SQLite file, which is what the tool's stock tier was set for.
	 */
	readonly approval = (args: unknown) =>
		cfgMemoryBackend.get(this.session.settings) === "memvidkb" &&
		(args as Partial<MemoryEditParams>)?.op !== "invalidate"
			? "write"
			: "read";
	readonly label = "Memory Edit";
	get description(): string {
		return prompt.render(memoryEditDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
			// The two backends hold different state under the same tool, so the promise the model
			// reads has to be the one this backend keeps: the knowledge service has no fact tier.
			memvidkb: cfgMemoryBackend.get(this.session.settings) === "memvidkb",
		});
	}
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate long-term memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "mnemopi" && backend !== "memvidkb") return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		if (cfgMemoryBackend.get(this.session.settings) === "memvidkb") {
			const result = await memvidkbBackend.edit(
				{
					agentDir: this.session.settings.getAgentDir(),
					cwd: this.session.cwd,
				},
				{
					op: params.op,
					id: params.id,
					content: params.content,
					replacementId: params.replacement_id,
					expectedCapturedAt: params.expected_captured_at,
				},
			);
			return {
				content: [{ type: "text", text: result.message }],
				details: result,
			};
		}

		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}

		const importance = params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance));
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? `Memory ${params.id} was not found${location}.`
				: result.status === "not_editable"
					? `Memory ${params.id} is a read-only fact${location}; it cannot be edited. Read it with memory://${params.id}.`
					: `Memory ${params.id} ${result.status}${location}.`;
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}
}
