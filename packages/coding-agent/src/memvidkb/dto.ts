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

/** One hit of `POST /memories/{id}/find` (`SearchResult`, `src/search.rs:115-124`). */
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

/** The non-array fields of a find page (`SearchResponse`, `src/search.rs:129-136`). */
export const FIND_PAGE = {
	query: "string",
	limit: "number",
	offset: "number",
	total: "number",
	mode: "string",
} as const satisfies FieldShape;

/** `POST /memories/{track}/records` answer (`RememberResponse`, `src/api/records/dto.rs:79-98`). */
export const REMEMBER_RESPONSE = {
	id: "string",
	uri: "string",
	frameId: "string",
	track: "string",
	title: "optstring",
	tags: "strings",
	originActor: "string",
	capturedAt: "string",
	derivedFrom: "optstring",
} as const satisfies FieldShape;

/** One row of `GET /memories/{track}/records` (`RecordListItem`, `src/api/records/dto.rs:148-170`). */
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

/** The non-array fields of the bounded record listing (`RecordListResponse`, `dto.rs:175-186`). */
export const RECORD_PAGE = {
	track: "string",
	total: "number",
	limit: "number",
	offset: "number",
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

/** Modes `POST /memories/{id}/find` accepts (`SearchMode`, `src/search.rs:32-44`, snake_case). */
export const FIND_MODES = ["lexical", "semantic", "hybrid", "temporal"] as const;

/** One find retrieval mode. */
export type FindMode = (typeof FIND_MODES)[number];

/** A `find` page: the paging fields plus its hits, once read. */
export type FindResponse = FindPageFields & { readonly results: readonly FindResultItem[] };

/** A record-listing page: the paging fields plus its rows, once read. */
export type RecordListing = RecordPageFields & { readonly records: readonly RecordListItem[] };

/** `GET /healthz` answer: the service's own health text, verbatim (`ok` when up). */
export type HealthReport = { readonly reachable: true; readonly body: string };
