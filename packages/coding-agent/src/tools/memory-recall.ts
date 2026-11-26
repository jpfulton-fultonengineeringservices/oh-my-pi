import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, untilAborted, toError } from "@oh-my-pi/pi-utils";
import { formatCurrentTime } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import { memvidkbBackend } from "../memvidkb/backend";
import type { MemoryBackendSearchItem } from "../memory-backend/types";
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
 * Each row is therefore addressable on the page, three ways: `track=` and `context=` name
 * the scope the row lives in, and `read:` carries the
 * `knowledge://record/<context>/<track>/<record-id>` pointer that reads the whole stored
 * text back. `memory_edit` and `memory_list` take record ids only, so a hit whose uri
 * addresses no record says so on its own line instead of leaving the caller to hand a
 * frame id to a route that cannot resolve it. No `memory://` pointer is ever emitted:
 * that scheme belongs to the retired local backends and throws on this backend.
 *
 * @param items - Hits from the backend, highest score first.
 * @returns One block per hit: id, track, context, source, score; then the read pointer;
 * then the text.
 */
type KnowledgeHit = Pick<
	MemoryBackendSearchItem,
	"id" | "source" | "content" | "score" | "track" | "context" | "pointer" | "truncated" | "snippetLimit"
>;

function formatKnowledgeHits(items: KnowledgeHit[]): string {
	return items
		.map((item, index) => {
			const head = [`#${String(index + 1)}`, `id=${item.id ?? "unknown"}`];
			if (item.track) head.push(`track=${item.track}`);
			if (item.context) head.push(`context=${item.context}`);
			if (item.source) head.push(`source=${item.source}`);
			if (item.score !== undefined) head.push(`score=${item.score.toFixed(4)}`);
			// The snippet is the service's own `bounded()` clip, so a hit landing on the
			// ceiling is text that continues somewhere the caller cannot see. Naming the
			// ceiling is what turns `read:` from a decoration into an instruction.
			if (item.truncated) head.push(`clippedAt=${String(item.snippetLimit ?? item.content.length)}`);
			const read = item.pointer
				? `read: ${item.pointer}`
				: "read: none — this hit addresses no record, so `id` is a frame id memory_edit cannot resolve";
			return [head.join(" "), read, item.content].join("\n");
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
		// Hand-literal rather than `isLiveMemoryBackend` on purpose: that helper excludes every
		// retired id, and `mnemopi` stays mounted and tested here until the retired-backend
		// refactor removes it. Re-adding `hindsight` to this list is not the fix — the mount pin
		// in test/memory-tools.test.ts refuses that registration on purpose.
		if (backend !== "mnemopi" && backend !== "memvidkb") return null;
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
					// The rendered text is for the model; this is the same provenance in
					// machine-readable form, so a caller reads `details.items[n].pointer`
					// instead of parsing the block back apart.
					details: {
						backend: result.backend,
						query: result.query,
						count: result.count,
						items: result.items,
					},
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

			// No storage path outside the knowledge service and mnemopi's local bank. Unreachable
			// by policy: the loader normalises a retired id to `off` and the runtime refuses one,
			// and `off` mounts nothing. Asserted rather than fallen through so that a re-introduced
			// retired id fails at the read instead of resolving to no result at all.
			throw new Error(`The recall tool has no storage path for the ${backend} memory backend.`);
		});
	}
}
