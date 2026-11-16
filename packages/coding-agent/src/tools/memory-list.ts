import { type } from "@oh-my-pi/omptype";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryListDescription from "../prompts/tools/memory-list.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import { memvidkbBackend } from "../memvidkb/backend";
import type { MemoryBackendListItem } from "../memory-backend/types";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryListSchema = type({
	"limit?": type("number").describe("how many records to list (bounded by the service)"),
	"offset?": type("number").describe("how many records to skip, for paging"),
});

export type MemoryListParams = typeof memoryListSchema.infer;

/** Rows one call returns when the caller asks for no page size. */
const DEFAULT_LIST_LIMIT = 25;

/**
 * Render one inventory row.
 *
 * The id leads because it is the only thing the model can act on: `memory_edit` addresses
 * a record by it. The preview comes last and clipped, so a listing costs context without
 * pretending to be the record's text.
 *
 * @param item - One row from the backend's listing.
 * @param index - Position on the page, for the leading ordinal.
 * @returns A `- [n] id=… captured=… verified=… origin=…` line plus its preview.
 */
function formatListRow(item: MemoryBackendListItem, index: number): string {
	const head = [
		`- [${String(index + 1)}]`,
		`id=${item.id}`,
		`captured=${item.capturedAt ?? "unknown"}`,
		`verified=${item.lastVerifiedAt ?? "never"}`,
		`origin=${item.originActor ?? "unknown"}`,
	];
	if (item.title) head.push(`title=${item.title}`);
	if (item.tags && item.tags.length > 0) head.push(`tags=${item.tags.join(",")}`);
	if (item.supersededBy) head.push(`supersededBy=${item.supersededBy}`);
	return `${head.join(" ")}\n  ${item.preview.replace(/\s+/g, " ").trim()}`;
}

/**
 * Bounded inventory of the knowledge service's records for this context's track.
 *
 * Stock OMP has no such verb: `recall` answers a query and `/memory stats` is an operator
 * surface, so nothing let a model enumerate what is stored. This tool fills that gap and
 * is offered only where a listing can actually be served — the memvidkb backend.
 */
export class MemoryListTool implements AgentTool<typeof memoryListSchema> {
	readonly name = "memory_list";
	readonly approval = "read" as const;
	readonly label = "Memory List";
	get description(): string {
		return prompt.render(memoryListDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
		});
	}
	readonly parameters = memoryListSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "List stored long-term memories without searching";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryListTool | null {
		// Only the knowledge service has a listable store; every other backend either has
		// no listing route or exposes its inventory through `/memory stats` instead.
		if (cfgMemoryBackend.get(session.settings) !== "memvidkb") return null;
		return new MemoryListTool(session);
	}

	async execute(_id: string, params: MemoryListParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const result = await memvidkbBackend.list(
				{
					agentDir: this.session.settings.getAgentDir(),
					cwd: this.session.cwd,
				},
				{
					limit: params.limit ?? DEFAULT_LIST_LIMIT,
					offset: params.offset,
					signal,
				},
			);
			// A refusal or an outage travels in `message` alongside zero items. Raising it is
			// the whole point: a listing that failed must never read as "nothing is stored".
			if (result.message !== undefined) {
				throw new Error(result.message);
			}
			if (result.count === 0) {
				return {
					content: [{ type: "text", text: `No records stored in ${result.scope ?? "this memory scope"}.` }],
					details: { backend: result.backend, count: 0, scope: result.scope },
				};
			}
			const rows = result.items.map(formatListRow).join("\n");
			const ofTotal = result.total === undefined ? "" : ` of ${String(result.total)}`;
			const pagedFrom = result.offset && result.offset > 0 ? ` (from offset ${String(result.offset)})` : "";
			return {
				content: [
					{
						type: "text",
						text: `${String(result.count)} record${result.count === 1 ? "" : "s"}${ofTotal} in ${result.scope ?? "memory"}${pagedFrom}:\n\n${rows}`,
					},
				],
				details: { backend: result.backend, count: result.count, scope: result.scope, total: result.total },
			};
		});
	}
}
