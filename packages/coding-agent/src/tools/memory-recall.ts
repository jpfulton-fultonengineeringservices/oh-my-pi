import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, untilAborted, toError } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import { memvidkbBackend } from "../memvidkb/backend";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
});

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

/**
 * Render knowledge-service hits as the ranked list the model expects from `recall`.
 *
 * Deliberately not `formatMemories` from the Hindsight layer: those rows carry Hindsight
 * fields, and a KB hit's identity is its record id plus the `mv2://` uri the service
 * addresses it by, which `memory_edit` needs to address the row again.
 *
 * @param items - Hits from the backend, highest score first.
 * @returns One block per hit: id, source, score, then the text.
 */
function formatKnowledgeHits(items: { id?: string; source?: string; content: string; score?: number }[]): string {
	return items
		.map((item, index) => {
			const head = [`#${String(index + 1)}`, `id=${item.id ?? "unknown"}`];
			if (item.source) head.push(`source=${item.source}`);
			if (item.score !== undefined) head.push(`score=${item.score.toFixed(4)}`);
			return `${head.join(" ")}\n${item.content}`;
		})
		.join("\n\n");
}

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	get description(): string {
		return prompt.render(recallDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
		});
	}
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "memvidkb") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = cfgMemoryBackend.get(this.session.settings);
			if (backend === "memvidkb") {
				const result = await memvidkbBackend.search(
					{
						agentDir: this.session.settings.getAgentDir(),
						cwd: this.session.cwd,
					},
					params.query,
					{ signal },
				);
				// An unreachable service is not an empty track. The prefixed reason throws so
				// no caller can read an outage as "nothing was ever stored here".
				if (result.message !== undefined) {
					logger.warn("recall failed", { backend: "memvidkb", query: params.query, error: result.message });
					throw new Error(result.message);
				}
				if (result.count === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Found ${String(result.count)} relevant ${result.count === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatKnowledgeHits(result.items)}`,
						},
					],
					details: {},
				};
			}

			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}
				try {
					const results = await state.recallResultsScoped(params.query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant memories found." }],
							details: {},
							useless: true,
						};
					}
					const formatted = state.formatScopedRecallWithIds(results);
					return {
						content: [
							{
								type: "text",
								text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
							},
						],
						details: {},
					};
				} catch (err) {
					logger.warn("recall failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw toError(err);
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw toError(err);
			}
		});
	}
}
