/**
 * Record-addressed verbs of the native memvidkb client.
 *
 * These three routes take a record id (or erase a whole document) rather than a track
 * collection, so they live here instead of in `client.ts`: that file is already over the
 * 500-line style target, and a verb that reads or rewrites one named row is a separate
 * concern from the collection verbs (`find`/`remember`/`list`/`health`) it keeps. Both
 * modules are scanned by the same wire-contract census in
 * `test/memvidkb-client-parity.test.ts`, so splitting them does not exempt either from
 * the "speaks no verb the service does not register" guard.
 *
 * Route authority for every path below is the service's own router:
 * `agents/memvid-kb-rs/src/lib.rs:155` (`/memories/{id}/erase`),
 * `:160-163` (`/memories/{id}/records/{record_id}`),
 * `:164-167` (`/memories/{id}/records/{record_id}/supersede`).
 * Field authority is `src/api/records/dto.rs` and `src/api/documents.rs`, cited per shape
 * in `./dto.ts`.
 */

import {
	callJsonParsed,
	requiredText,
	readShape,
	trackPath,
	type MemvidkbEndpoint,
	type MemvidkbOutcome,
} from "./client";
import {
	ERASE_REPORT,
	RECORD_DETAIL,
	SUPERSEDE_RESPONSE,
	type EraseReport,
	type RecordDetail,
	type SupersedeResponse,
} from "./dto";

/** One record's route, with the id encoded so a slug cannot escape its path segment. */
function recordPath(track: string, recordId: string, suffix: string): string {
	return `${trackPath(track, "/records")}/${encodeURIComponent(recordId)}${suffix}`;
}

/**
 * Read one record in full, text included (`GET /memories/{track}/records/{record_id}`).
 *
 * The bounded listing deliberately serves only a clipped snippet, so this is the call
 * that answers "what does this record actually say" — and the one `memory_edit forget`
 * uses to turn an id into the `uri` the erase route requires.
 *
 * @param endpoint - Service origin and bearer.
 * @param args - Track and record id.
 * @param signal - Caller cancellation.
 * @returns The record, or a prefixed failure; an outage is never reported as "no such record".
 */
export async function inspectRecord(
	endpoint: MemvidkbEndpoint,
	args: { readonly track: string; readonly recordId: string },
	signal?: AbortSignal,
): Promise<MemvidkbOutcome<RecordDetail>> {
	const verb = "record read";
	const track = requiredText(verb, "track", args.track);
	if (!track.ok) return { ok: false, error: track.error };
	const recordId = requiredText(verb, "recordId", args.recordId);
	if (!recordId.ok) return { ok: false, error: recordId.error };
	return callJsonParsed(
		endpoint,
		{
			method: "GET",
			path: recordPath(track.value, recordId.value, ""),
			subject: `record "${recordId.value}" in track "${track.value}"`,
		},
		signal,
		body => readShape(verb, body, RECORD_DETAIL),
	);
}

/**
 * Replace one record by writing its successor (`POST /memories/{track}/records/{record_id}/supersede`).
 *
 * The service has no in-place update: `content` is corrected by minting a successor and
 * pointing the prior record at it, which is why the outcome reports both ids and both
 * URIs. Only the two documented required fields go on the wire — the optional
 * `id`/`capturedAt`/`provider` keys are left off rather than sent as empty strings,
 * which the service would read as caller-chosen values.
 *
 * @param endpoint - Service origin and bearer.
 * @param args - Track, record id, corrected text, and the actor making the correction.
 * @param signal - Caller cancellation.
 * @returns The swapped pair, or a prefixed failure; a failure superseded nothing.
 */
export async function supersedeRecord(
	endpoint: MemvidkbEndpoint,
	args: {
		readonly track: string;
		readonly recordId: string;
		readonly content: string;
		readonly originActor: string;
	},
	signal?: AbortSignal,
): Promise<MemvidkbOutcome<SupersedeResponse>> {
	const verb = "supersede";
	const track = requiredText(verb, "track", args.track);
	if (!track.ok) return { ok: false, error: track.error };
	const recordId = requiredText(verb, "recordId", args.recordId);
	if (!recordId.ok) return { ok: false, error: recordId.error };
	const content = requiredText(verb, "content", args.content);
	if (!content.ok) return { ok: false, error: content.error };
	const originActor = requiredText(verb, "originActor", args.originActor);
	if (!originActor.ok) return { ok: false, error: originActor.error };
	return callJsonParsed(
		endpoint,
		{
			method: "POST",
			path: recordPath(track.value, recordId.value, "/supersede"),
			body: { content: content.value, originActor: originActor.value },
			subject: `supersede of record "${recordId.value}" in track "${track.value}"`,
			write: true,
		},
		signal,
		body => readShape(verb, body, SUPERSEDE_RESPONSE),
	);
}

/**
 * Delete a stored document and every frame under it (`POST /memories/{track}/erase`).
 *
 * Erase is addressed by `sourceUri`, not by record id — that is the service's own
 * contract (`EraseRequest { source_uri }`, `src/api/documents.rs:31-34`) — so callers
 * resolve the uri first. A report with zero frames removed is not a deletion, and
 * `residualFrames` names whatever the service could not remove; both stay in the message
 * rather than being smoothed into "erased".
 *
 * @param endpoint - Service origin and bearer.
 * @param args - Track and the `mv2://` uri to erase.
 * @param signal - Caller cancellation.
 * @returns The service's removal accounting, or a prefixed failure; a failure removed nothing.
 */
export async function eraseDocument(
	endpoint: MemvidkbEndpoint,
	args: { readonly track: string; readonly sourceUri: string },
	signal?: AbortSignal,
): Promise<MemvidkbOutcome<EraseReport>> {
	const verb = "erase";
	const track = requiredText(verb, "track", args.track);
	if (!track.ok) return { ok: false, error: track.error };
	const sourceUri = requiredText(verb, "sourceUri", args.sourceUri);
	if (!sourceUri.ok) return { ok: false, error: sourceUri.error };
	return callJsonParsed(
		endpoint,
		{
			method: "POST",
			path: trackPath(track.value, "/erase"),
			body: { sourceUri: sourceUri.value },
			subject: `erase of "${sourceUri.value}" from track "${track.value}"`,
			write: true,
		},
		signal,
		body => readShape(verb, body, ERASE_REPORT),
	);
}
