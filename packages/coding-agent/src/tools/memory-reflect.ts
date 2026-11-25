import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, untilAborted, toError } from "@oh-my-pi/pi-utils";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import { memvidkbBackend } from "../memvidkb/backend";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryReflectSchema = type({
	query: type("string").describe("question to answer"),
	"context?": type("string").describe("optional context"),
});

/**
 * Hits one reflection draws on. Deliberately smaller than `recall`'s ceiling: a
 * synthesis reads a handful of the best-matching records, and a wider page costs
 * context without changing the answer.
 */
const REFLECT_SOURCE_LIMIT = 12;

export type MemoryReflectParams = typeof memoryReflectSchema.infer;

export class MemoryReflectTool implements AgentTool<typeof memoryReflectSchema> {
	readonly name = "reflect";
	readonly approval = "read" as const;
	readonly label = "Reflect";
	get description(): string {
		return prompt.render(reflectDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
		});
	}
	readonly parameters = memoryReflectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Synthesize an answer from long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryReflectTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		// Hand-literal rather than `isLiveMemoryBackend` on purpose: that helper excludes every
		// retired id, and `mnemopi` stays mounted and tested here until the retired-backend
		// refactor removes it. Re-adding `hindsight` to this list is not the fix — the mount pin
		// in test/memory-tools.test.ts refuses that registration on purpose.
		if (backend !== "mnemopi" && backend !== "memvidkb") return null;
		return new MemoryReflectTool(session);
	}

	async execute(_id: string, params: MemoryReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = cfgMemoryBackend.get(this.session.settings);
			if (backend === "memvidkb") {
				// Synthesis here is retrieval plus framing, exactly the shape the mnemopi
				// branch below uses: the service's own `POST /memories/{track}/ask` answers
				// with a generated summary, and this client does not speak that route — so
				// the honest output is what was retrieved, attributed, not a paraphrase.
				const query = params.context?.trim()
					? `${params.query.trim()}\n\nAdditional context:\n${params.context.trim()}`
					: params.query;
				const result = await memvidkbBackend.search(
					{
						agentDir: this.session.settings.getAgentDir(),
						cwd: this.session.cwd,
					},
					query,
					{ signal, limit: REFLECT_SOURCE_LIMIT },
				);
				if (result.message !== undefined) {
					logger.warn("reflect failed", { backend: "memvidkb", query: params.query, error: result.message });
					throw new Error(result.message);
				}
				if (result.count === 0) {
					return {
						content: [{ type: "text", text: "No relevant information found to reflect on." }],
						details: {},
					};
				}
				const summary = result.items
					.map((item, index) => {
						const origin = item.source ?? item.id ?? "unknown source";
						return `- [${String(index + 1)}] (${origin}) ${item.content.replace(/\s+/g, " ").trim()}`;
					})
					.join("\n");
				return {
					content: [{ type: "text", text: `Based on recalled memories:\n\n${summary}` }],
					details: {},
				};
			}

			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}

				try {
					const query = params.context?.trim()
						? `${params.query.trim()}\n\nAdditional context:\n${params.context.trim()}`
						: params.query;
					const results = await state.recallResultsScoped(query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant information found to reflect on." }],
							details: {},
						};
					}
					const summary = state.formatContextScoped(results);
					return {
						content: [{ type: "text", text: `Based on recalled memories:\n\n${summary}` }],
						details: {},
					};
				} catch (err) {
					logger.warn("reflect failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw toError(err);
				}
			}

			// No synthesis path outside the knowledge service and mnemopi's local bank. Unreachable
			// by policy: the loader normalises a retired id to `off` and the runtime refuses one,
			// and `off` mounts nothing. Asserted rather than fallen through so that a re-introduced
			// retired id fails at the read instead of resolving to no result at all.
			throw new Error(`The reflect tool has no storage path for the ${backend} memory backend.`);
		});
	}
}
