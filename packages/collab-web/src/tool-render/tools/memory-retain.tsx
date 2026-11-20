/** `retain` — store facts in long-term memory (one bullet per stored item). */
import type { ReactNode } from "react";
import { Badge, InvalidArg, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, replaceTabs, resultTextOf, str, truncate } from "../util";

interface RetainItem {
	content: string;
	context: string | null;
	/** Slot this item came from in `args.items`. */
	index: number;
}

/**
 * Narrow `args.items`; null = present but malformed, [] = absent/empty.
 *
 * A blank-content item is skipped but keeps the slot it occupied: the backend wrote it
 * and holds an id for it, so numbering the surviving rows by rendered position would
 * slide every later id onto the content of another item — and the id is the handle
 * `memory_edit` addresses a record by.
 */
function retainItems(args: Record<string, unknown>): RetainItem[] | null {
	const raw = args.items;
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	const items: RetainItem[] = [];
	for (const [index, entry] of raw.entries()) {
		if (!isRecord(entry)) continue;
		const content = replaceTabs((str(entry.content) ?? "").trim());
		if (!content) continue;
		items.push({ content, context: str(entry.context), index });
	}
	return items;
}

/** `result.details.ids` as a positional list; a non-string slot is no handle. */
function retainIds(result: ToolRenderProps["result"]): readonly (string | undefined)[] {
	const raw = detailsRecord(result)?.ids;
	if (!Array.isArray(raw)) return [];
	return raw.map(entry => (typeof entry === "string" && entry.length > 0 ? entry : undefined));
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const items = retainItems(args);
	if (items === null) return <InvalidArg what="items" />;
	const count = num(detailsRecord(result)?.count) ?? items.length;
	const first = items[0] ? truncate(normalizeWs(items[0].content), 80) : "";
	return (
		<>
			<Badge tone="accent">{count === 1 ? "1 memory" : `${count} memories`}</Badge>
			{first && <span className="tv-trunc">{first}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const items = retainItems(args);
	const count = num(detailsRecord(result)?.count);
	// The tool's own "N memories stored/queued." line, and only that first line: the
	// per-item ids the tool reports ride on the lines below it, beside the content they
	// name. Trailing period dropped so it reads as a status chip; the lone item's id is
	// stripped for the same reason — its row below already carries it.
	let confirmation: string | null = null;
	if (result && result.isError !== true) {
		const text = resultTextOf(result)
			.split("\n", 1)[0]
			.trim()
			.replace(/\s+id=\S+$/, "")
			.replace(/\.$/, "");
		confirmation = text || (count !== null ? `${count === 1 ? "1 memory" : `${count} memories`} retained` : null);
	}
	const ids = retainIds(result);
	return (
		<>
			{items === null ? (
				<InvalidArg what="items" />
			) : (
				items.length > 0 && (
					<div className="tv-list">
						{items.map(item => (
							<Row key={item.index}>
								{item.content}
								{item.context && <span className="tv-faint"> — {item.context}</span>}
								{ids[item.index] && <span className="tv-faint"> id={ids[item.index]}</span>}
							</Row>
						))}
					</div>
				)
			)}
			{confirmation ? (
				<div>
					<Badge tone="ok">{confirmation}</Badge>
				</div>
			) : (
				<ResultText result={result} maxLines={6} />
			)}
		</>
	);
}

export const retainRenderer: ToolRenderer = { Summary, Body };
