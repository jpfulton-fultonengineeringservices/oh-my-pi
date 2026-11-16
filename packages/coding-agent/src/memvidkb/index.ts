/**
 * Native memory backend for the memvid-kb-rs knowledge service.
 *
 * Selected by `memory.backend === "memvidkb"` (see `../memory-backend/resolve`). The
 * service owns the memory; this module owns the thin client that reaches it and the
 * `MemoryBackend` shape the agent loop expects.
 */

export { memvidkbBackend } from "./backend";
export {
	loadMemvidkbBackendConfig,
	selectDefaultTrack,
	type MemvidkbBackendConfig,
	type MemvidkbBackendConfigResult,
} from "./config";
export {
	HEALTH_TIMEOUT_MS,
	HTTP_TIMEOUT_MS,
	allowedValue,
	eraseDocument,
	findTrack,
	health,
	inspectRecord,
	listRecords,
	readRows,
	readShape,
	refuseRequest,
	refuseResponse,
	rememberRecord,
	requiredText,
	supersedeRecord,
	type FindOptions,
	type MemvidkbBody,
	type MemvidkbEndpoint,
	type MemvidkbOutcome,
	type MemvidkbParsed,
	type MemvidkbRefusal,
	type MemvidkbRequest,
} from "./client";
export {
	ERASE_REPORT,
	FIND_MODES,
	FIND_PAGE,
	FIND_RESULT,
	RECORD_DETAIL,
	RECORD_LIST_ITEM,
	RECORD_PAGE,
	REMEMBER_RESPONSE,
	SUPERSEDE_RESPONSE,
	type FieldKind,
	type FieldShape,
	type EraseReport,
	type FindMode,
	type FindResponse,
	type FindResultItem,
	type HealthReport,
	type RecordDetail,
	type RecordListItem,
	type RecordListing,
	type RememberResponse,
	type SupersedeResponse,
	type Shaped,
} from "./dto";
export { KNOWLEDGE_ERROR_PREFIX, KNOWLEDGE_ERROR_PREFIXES, hasKnowledgeErrorPrefix, redactToken } from "./errors";
