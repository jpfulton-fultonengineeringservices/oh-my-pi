import type { MemoryRetainDetails } from "@oh-my-pi/pi-tui/tools/memory";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt, withLoopPhase } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import { memvidkbBackend } from "../memvidkb/backend";
import type { ToolSession } from ".";

import { isGlobalMemoryScopeAvailable } from "../memory-backend/global-scope";
import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryRetainSchemaBase = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

/** Offered only where every project recalls a global item; see {@link isGlobalMemoryScopeAvailable}. */
const memoryRetainSchemaWithScope = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"scope?": type("'project' | 'global'").describe(
			"storage scope; defaults to project, global is for durable cross-project knowledge",
		),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

type MemoryRetainSchema = typeof memoryRetainSchemaBase | typeof memoryRetainSchemaWithScope;

export type MemoryRetainParams = typeof memoryRetainSchemaWithScope.infer;

/**
 * The success result for a backend that answers a write with the id it assigned.
 *
 * The ids go in the model-visible text, one line per item, because the id is the
 * handle `memory_edit` and `recall` address a record by: a result that says only
 * "2 memories stored." leaves the agent to re-list the store and guess which row
 * it just wrote. Item numbers are the caller's own input order, matching the
 * wording the partial-failure path uses for the ids it did keep. A lone item puts
 * its id on the count line itself: there is no other item to tell it apart from,
 * and one line is what the model reads first.
 */
function storedResult(storedIds: string[], count: number): AgentToolResult<MemoryRetainDetails> {
	const noun = count === 1 ? "memory" : "memories";
	const head = `${String(count)} ${noun} stored.`;
	// An empty id is not a handle: it is dropped rather than reported as `(id )`,
	// while the surviving ones keep the item number of the slot they came from.
	const ids = storedIds.filter(id => id.length > 0);
	const text =
		count === 1 && ids.length === 1
			? `${head} id=${ids[0]}`
			: [head, ...storedIds.map((id, index) => (id.length > 0 ? `item ${String(index + 1)} (id ${id})` : ""))]
					.filter(line => line.length > 0)
					.join("\n");
	return {
		content: [{ type: "text", text }],
		details: ids.length > 0 ? { count, ids } : { count },
	};
}

export class MemoryRetainTool implements AgentTool<MemoryRetainSchema, MemoryRetainDetails> {
	readonly name = "retain";
	/** A global item reaches every project's recall, so it needs the same approval as a file write. */
	readonly approval = (args: unknown) =>
		(args as Partial<MemoryRetainParams>).items?.some(item => item.scope === "global") ? "write" : "read";
	readonly label = "Retain";
	get description(): string {
		return prompt.render(retainDescription, { globalScope: isGlobalMemoryScopeAvailable(this.session) });
	}
	get parameters(): MemoryRetainSchema {
		return isGlobalMemoryScopeAvailable(this.session) ? memoryRetainSchemaWithScope : memoryRetainSchemaBase;
	}
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "memvidkb") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRetainTool(session);
	}

	async execute(toolCallId: string, params: MemoryRetainParams): Promise<AgentToolResult<MemoryRetainDetails>> {
		const backend = cfgMemoryBackend.get(this.session.settings);
		if (backend === "memvidkb") {
			// No global tier exists in the knowledge service: a track is scoped by the
			// context in `.memvidkb`, so an item asking for global storage is refused
			// before anything is written rather than quietly filed as project memory.
			if (params.items.some(item => item.scope === "global")) {
				throw new Error("Global memory scope is not available with the memvidkb memory backend.");
			}
			const context = {
				agentDir: this.session.settings.getAgentDir(),
				cwd: this.session.cwd,
			};
			// A failed item stores nothing and stops the batch, so the caller retries only
			// what failed instead of trusting a success count that never happened.
			const storedIds: string[] = [];
			for (const [index, item] of params.items.entries()) {
				const result = await memvidkbBackend.save(context, {
					content: item.content,
					context: item.context,
					source: "coding-agent-retain",
				});
				if (result.stored === 0) {
					const reason = result.message ?? "the service stored nothing";
					const kept =
						storedIds.length === 0
							? "Nothing was stored."
							: `Stored before the failure and kept: ${storedIds.map((storedId, storedIndex) => `item ${String(storedIndex + 1)} (id ${storedId})`).join(", ")}.`;
					const untried = index + 1 < params.items.length ? " Later items were not attempted." : "";
					throw new Error(
						`memvidkb did not store item ${String(index + 1)} of ${String(params.items.length)}: ${reason}. ${kept}${untried}`,
					);
				}
				storedIds.push(...(result.ids ?? []));
			}
			return storedResult(storedIds, params.items.length);
		}

		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}
			return withLoopPhase("mnemopi.retain", () => {
				// Resolve the global bank first, so an unsupported scoping mode rejects the batch before any item is stored.
				const globalTarget = params.items.some(item => item.scope === "global")
					? state.getGlobalRetainTarget()
					: undefined;

				// A failed write stored nothing. Stop there and say why, and what the batch
				// kept, so the caller retries only what failed instead of trusting a
				// success count.
				const storedIds: string[] = [];
				for (const [index, item] of params.items.entries()) {
					let id: string;
					try {
						id = state.rememberScoped(
							item.content,
							{
								source: "coding-agent-retain",
								importance: 0.75,
								metadata: {
									session_id: state.sessionId,
									cwd: state.session.sessionManager.getCwd(),
									context: item.context ?? null,
									tool: "retain",
								},
								scope: "bank",
								extract: true,
								extractEntities: true,
								veracity: "tool",
								memoryType: "fact",
							},
							item.scope === "global" ? globalTarget : undefined,
						);
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						const kept =
							storedIds.length === 0
								? "Nothing was stored."
								: `Stored before the failure and kept: ${storedIds.map((storedId, storedIndex) => `item ${storedIndex + 1} (id ${storedId})`).join(", ")}.`;
						const untried = index + 1 < params.items.length ? " Later items were not attempted." : "";
						throw new Error(
							`Mnemopi did not store item ${index + 1} of ${params.items.length}: ${reason}. ${kept}${untried}`,
							{ cause: error },
						);
					}
					storedIds.push(id);
				}

				return storedResult(storedIds, params.items.length);
			});
		}

		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}
		// Check before queueing anything, so a disabled or unsupported global scope rejects the whole batch.
		if (params.items.some(item => item.scope === "global")) {
			state.assertGlobalRetainAvailable();
		}

		// Acknowledge only once the whole call is on disk; delivery happens on a later flush.
		await state.enqueueRetain(toolCallId, params.items);

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
