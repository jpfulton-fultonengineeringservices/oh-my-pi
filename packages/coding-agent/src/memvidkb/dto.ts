/**
 * Wire vocabulary of the native `memvidkb` backend: the shape each route answers,
 * the value set a request may name, and the parser that reads one into the other.
 *
 * A field name is written down exactly once here, as both the type (`Shaped<typeof X>`)
 * and the parser (`readShape(verb, body, X)`), so a response field cannot drift
 * between a declared type and a checking reader. Names are the service's, taken from
 * its DTOs: `src/search.rs` (`SearchQuery`, `SearchResult`, `SearchResponse`),
 * `src/api/records/dto.rs` (`RememberRequest`, `RememberResponse`, `RecordListItem`,
 * `RecordListResponse`). Every DTO is `#[serde(rename_all = "camelCase")]`, which is
 * why `lastVerifiedAt` — the stamp a record read back and a verify request both
 * carry — keeps one spelling on both sides of the call.
 *
 * `find` is the service's discovery route (`POST /memories/{id}/find`,
 * `src/lib.rs:148`); there is no `discover` route to call.
 */

/** One field's documented wire type. */
export type FieldKind = "string" | "number" | "strings" | "optstring" | "optnumber";

type FieldValue<K extends FieldKind> = K extends "string"
	? string
	: K extends "number"
		? number
		: K extends "strings"
			? readonly string[]
			: K extends "optstring"
				? string | null
				: number | null;

/** The field names and wire types one documented response is read by. */
export type FieldShape = Record<string, FieldKind>;

/** The value type a shape describes, so a response field name is written once. */
export type Shaped<S extends FieldShape> = { readonly [K in keyof S]: FieldValue<S[K]> };

/** One hit of `POST /memories/{id}/find` (`SearchResult`, `src/search.rs:121-133`). */
export const FIND_RESULT = {
	frameId: "string",
	/** Parent document URI; chunk frames are attributed to the ingested doc. */
	documentId: "string",
	uri: "string",
	score: "number",
	textSnippet: "string",
	title: "optstring",
	/** Unix seconds, and `0` when the frame carried no `createdAt` — never a 1970 date. */
	timestamp: "number",
} as const satisfies FieldShape;

/** The non-array fields of a find page (`SearchResponse`, `src/search.rs:135-145`). */
export const FIND_PAGE = {
	query: "string",
	limit: "number",
	offset: "number",
	total: "number",
	mode: "string",
} as const satisfies FieldShape;

/**
 * `POST /memories/{track}/records` answer (`RememberResponse`, `src/api/records/dto.rs:90-114`).
 * The deployed service emits `lastVerifiedAt` on this answer too (`dto.rs:110-111`) — `null`
 * when the record was never verified — so the shape carries it.
 */
export const REMEMBER_RESPONSE = {
	id: "string",
	uri: "string",
	frameId: "string",
	track: "string",
	title: "optstring",
	tags: "strings",
	originActor: "string",
	capturedAt: "string",
	/** `null` when never verified; the same spelling the listing and detail answers use. */
	lastVerifiedAt: "optstring",
	derivedFrom: "optstring",
} as const satisfies FieldShape;

/** One row of `GET /memories/{track}/records` (`RecordListItem`, `src/api/records/dto.rs:161-186`). */
export const RECORD_LIST_ITEM = {
	id: "string",
	uri: "string",
	title: "optstring",
	tags: "strings",
	originActor: "string",
	capturedAt: "string",
	/** `null` when never verified; the same spelling a verify request sends. */
	lastVerifiedAt: "optstring",
	derivedFrom: "optstring",
	supersededBy: "optstring",
	textSnippet: "string",
} as const satisfies FieldShape;

/** The non-array fields of the bounded record listing (`RecordListResponse`, `src/api/records/dto.rs:188-202`). */
export const RECORD_PAGE = {
	track: "string",
	total: "number",
	limit: "number",
	offset: "number",
} as const satisfies FieldShape;

/**
 * One full record from `GET /memories/{track}/records/{record_id}` (`RecordResponse`,
 * `src/api/records/dto.rs:116-142`). The only response that carries `text`: the listing
 * route deliberately serves a clipped snippet instead.
 */
export const RECORD_DETAIL = {
	id: "string",
	track: "string",
	uri: "string",
	title: "optstring",
	tags: "strings",
	text: "string",
	originActor: "string",
	capturedAt: "string",
	lastVerifiedAt: "optstring",
	derivedFrom: "optstring",
	supersededBy: "optstring",
} as const satisfies FieldShape;

/**
 * `POST /memories/{track}/records/{record_id}/supersede` answer (`SupersedeResponse`,
 * `src/api/records/dto.rs:204-216`). Both ids and both URIs come back so the caller can
 * say which record was replaced and which one now stands, without a second read.
 */
export const SUPERSEDE_RESPONSE = {
	priorId: "string",
	newId: "string",
	priorUri: "string",
	newUri: "string",
} as const satisfies FieldShape;

/**
 * `POST /memories/{track}/erase` answer (`EraseReport`, `src/api/documents.rs:46-51`).
 * `residualFrames` carries every frame whose delete was attempted and failed, so a
 * zero-count report can never be read as a completed deletion. There is deliberately no
 * card count: the pinned `memvid-core` exposes no selective card delete.
 */
export const ERASE_REPORT = {
	framesRemoved: "number",
	chunksRemoved: "number",
	residualFrames: "strings",
} as const satisfies FieldShape;

/** One hit of a find page. */
export type FindResultItem = Shaped<typeof FIND_RESULT>;

/** The paging fields a find page reports alongside its hits. */
export type FindPageFields = Shaped<typeof FIND_PAGE>;

/** What the service stored for one `remember` call. */
export type RememberResponse = Shaped<typeof REMEMBER_RESPONSE>;

/** One row of the bounded record listing, without the full text. */
export type RecordListItem = Shaped<typeof RECORD_LIST_ITEM>;

/** The paging fields of the bounded record listing. */
export type RecordPageFields = Shaped<typeof RECORD_PAGE>;

/** One full record, text and all provenance fields included. */
export type RecordDetail = Shaped<typeof RECORD_DETAIL>;

/** What a supersede call reports about the pair it swapped. */
export type SupersedeResponse = Shaped<typeof SUPERSEDE_RESPONSE>;

/** What an erase call actually removed, per the service's own accounting. */
export type EraseReport = Shaped<typeof ERASE_REPORT>;

/** Modes `POST /memories/{id}/find` accepts (`SearchMode`, `src/search.rs:40-53`, snake_case). */
export const FIND_MODES = ["lexical", "semantic", "hybrid", "temporal"] as const;

/** One find retrieval mode. */
export type FindMode = (typeof FIND_MODES)[number];

/** A `find` page: the paging fields plus its hits, once read. */
export type FindResponse = FindPageFields & { readonly results: readonly FindResultItem[] };

/** A record-listing page: the paging fields plus its rows, once read. */
export type RecordListing = RecordPageFields & { readonly records: readonly RecordListItem[] };

/** `GET /healthz` answer: the service's own health text, verbatim (`ok` when up). */
export type HealthReport = { readonly reachable: true; readonly body: string };
