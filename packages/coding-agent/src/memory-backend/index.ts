export type { MnemopiBackendConfig, MnemopiLlmMode, MnemopiProviderOptions, MnemopiScoping } from "../mnemopi/config";
export type {
	MnemopiMemoryEditOperation,
	MnemopiMemoryEditOptions,
	MnemopiMemoryEditResult,
	MnemopiSessionState,
	MnemopiSessionStateApi,
	MnemopiSessionStateOptions,
} from "../mnemopi/state";
export * from "./local-backend";
export * from "./messages";
export * from "./off-backend";
// Named, not `export *`: the recall writer is not public surface. `persistRecall` and
// `findPersistedRecall` take a `SessionManager`-shaped argument and would let a consumer
// append a recall entry directly, bypassing the only persist site that is allowed to —
// `memvidkb`'s `commit()` success arm, which writes an entry only for a block the model
// actually received. The heading is exported because another repository matches on it.
export { MEMVID_RECALL_HEADING } from "./recall-entry";
export * from "./resolve";
export * from "./runtime";
export * from "./types";
