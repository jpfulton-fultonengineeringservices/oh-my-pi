/**
 * Memory backend abstraction.
 *
 * Backends are mutually exclusive — `await resolveMemoryBackend(settings)` returns
 * exactly one. Implementations MUST be self-contained: they own the per-session
 * state they create in `start()` and tear it down on `clear()`.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { HindsightSessionStateApi } from "../hindsight/state";
import type { MnemopiSessionStateApi } from "../mnemopi/state";
import type { AgentSession } from "../session/agent-session";

export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "sharpshooter" | "memvidkb";

export interface MemoryBackendStatus {
	backend: MemoryBackendId;
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}

export interface MemoryBackendSearchOptions {
	limit?: number;
	/** Best-effort abort signal. Backends may only observe it before/after an underlying recall call. */
	signal?: AbortSignal;
}

export interface MemoryBackendSearchItem {
	id?: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
}

export interface MemoryBackendSearchResult {
	backend: MemoryBackendId;
	query: string;
	count: number;
	items: MemoryBackendSearchItem[];
	message?: string;
}

export interface MemoryBackendSaveInput {
	content: string;
	context?: string;
	source?: string;
	importance?: number;
	/**
	 * Gateway provider that produced the content being stored — per-call provenance, never
	 * a `.memvidkb` key. The memvidkb backend sends it as the record's `provider` and
	 * refuses locally, before anything is sent, when the workspace's `.memvidkb` "providers"
	 * grant is non-empty and does not admit it. Absent means no producer was named, which
	 * leaves the decision to the service.
	 */
	provider?: string;
}

export interface MemoryBackendSaveResult {
	backend: MemoryBackendId;
	stored: number;
	ids?: string[];
	queued?: boolean;
	message?: string;
}

/** Paging for an inventory read; omitted paging stays with the backend's default. */
export interface MemoryBackendListOptions {
	/** How many rows to return. Backends clip this to their own ceiling. */
	limit?: number;
	/** Rows to skip; omitted means 0. */
	offset?: number;
	/** Best-effort abort signal. Backends may only observe it before/after an underlying call. */
	signal?: AbortSignal;
}

/** One inventory row: what is stored, without its full text. */
export interface MemoryBackendListItem {
	/** The id a later `memory_edit` addresses this row by. */
	id: string;
	/** The handle the backend itself uses, when it has one. */
	source?: string;
	/** Display title, when the backend carries one. */
	title?: string | null;
	/** Caller-supplied labels. */
	tags?: readonly string[];
	/** Who produced the row, when the backend records provenance. */
	originActor?: string;
	/** When the row was captured, as the backend spells it. */
	capturedAt?: string;
	/** When the row was last verified, `null` when never — never a fake date. */
	lastVerifiedAt?: string | null;
	/** The row that supersedes this one, `null` while it is current. */
	supersededBy?: string | null;
	/** Leading slice of the stored text; the full text needs a per-row read. */
	preview: string;
}

/** A bounded inventory page, or a prefixed refusal naming why nothing was listed. */
export interface MemoryBackendListResult {
	backend: MemoryBackendId;
	/** The scope the listing covers (a track, bank, or file), when the backend has one. */
	scope?: string;
	count: number;
	/** Total rows in the scope before paging, when the backend reports it. */
	total?: number;
	offset?: number;
	items: MemoryBackendListItem[];
	message?: string;
}

/** One model-requested mutation of a single existing memory. */
export interface MemoryBackendEditInput {
	op: "update" | "forget" | "invalidate";
	/** Memory id from a recall or list result. */
	id: string;
	/** Replacement text for `update`. */
	content?: string;
	/** Successor id for `invalidate`, when the backend supports soft supersession. */
	replacementId?: string;
}

/** What one edit call did, or precisely what it refused to do. */
export interface MemoryBackendEditResult {
	backend: MemoryBackendId;
	status: "updated" | "forgotten" | "invalidated" | "not_found" | "unsupported" | "failed";
	/** Human-readable outcome, always present so the tool never has to invent one. */
	message: string;
}

export interface MemoryBackendOperationContext {
	agentDir: string;
	cwd: string;
	session?: AgentSession;
}

export interface MemoryRuntimeContext {
	status(): Promise<MemoryBackendStatus>;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: string | MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
	list(options?: MemoryBackendListOptions): Promise<MemoryBackendListResult>;
	edit(input: MemoryBackendEditInput): Promise<MemoryBackendEditResult>;
}

export interface MemoryBackendStartOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
	parentHindsightSessionState?: HindsightSessionStateApi;
	parentMnemopiSessionState?: MnemopiSessionStateApi;
}

/** A successful recall, including an empty result, staged until user-turn delivery. */
export interface MemoryPromptPreparation {
	context?: string;
	/**
	 * Model-facing note delivered with this turn's user message, e.g. what changed in the
	 * memories a reused recall holds. Persisted in the transcript as a hidden custom message
	 * whose `details` carry the backend's bookkeeping, so both land only once delivered.
	 */
	notice?: { content: string; details: unknown };
	/** Commit synchronously after delivery validation; false rejects lost ownership without state writes. */
	commit(): boolean;
}

export interface MemoryBackend {
	readonly id: MemoryBackendId;

	/**
	 * Wire any background work or session subscriptions for this backend.
	 *
	 * Called once per agent session at startup. Implementations MUST be
	 * non-throwing: failures should be logged and swallowed so a misconfigured
	 * memory backend cannot break the agent loop.
	 */
	start(options: MemoryBackendStartOptions): void | Promise<void>;

	/**
	 * Markdown injected as the system-prompt append section.
	 * Returned on every prompt rebuild via `refreshBaseSystemPrompt()`.
	 * `cwd` is the session's project directory and selects project-scoped memory.
	 */
	buildDeveloperInstructions(
		agentDir: string,
		cwd: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	/** Wipe all persisted state for this backend (slash `/memory clear`). */
	clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Force consolidation/retain to happen now (slash `/memory enqueue`). */
	enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Structured state for UI, slash commands, and extensions. */
	status?(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus>;

	/** Explicit user-facing semantic/lexical search. */
	search?(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult>;

	/** Explicit user-facing save operation. */
	save?(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
	/**
	 * Bounded inventory of what is stored, without full text. Optional: a backend that
	 * has no listable store omits it and the runtime says so rather than listing nothing.
	 */
	list?(context: MemoryBackendOperationContext, options?: MemoryBackendListOptions): Promise<MemoryBackendListResult>;
	/**
	 * Mutate one existing memory by id. Optional: a backend without a per-record write
	 * route omits it, so the tool reports the refusal instead of pretending the op ran.
	 */
	edit?(context: MemoryBackendOperationContext, input: MemoryBackendEditInput): Promise<MemoryBackendEditResult>;

	/** Render backend-specific memory statistics as markdown (`/memory stats`). */
	stats?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

	/** Render backend-specific memory diagnostics as markdown (`/memory diagnose`). */
	diagnose?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;
	/** Render pending deltas awaiting consolidation (`/memory queue`). */
	queuePreview?(context: MemoryBackendOperationContext): Promise<string | undefined>;
	/**
	 * Optional hook to inject a backend-specific block into the current turn's
	 * system prompt before the agent starts generating.
	 *
	 * This is the only place a backend can affect the very first answer of a
	 * fresh session. Context is appended to the winning base prompt at delivery;
	 * commit publishes the cached snippet and first-turn consumption together.
	 * Return undefined for an ineligible or failed recall, not an empty success.
	 */
	beforeAgentStartPrompt?(
		session: AgentSession,
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined>;

	/**
	 * Optional hook to splice extra context into a compaction summarization.
	 *
	 * Called from the compaction call site before the LLM summary is requested.
	 * Returning a string appends one entry to the compaction's `extraContext`
	 * list (which becomes part of the summarization prompt). Return `undefined`
	 * to inject nothing — the local backend takes this branch because its
	 * summary is already part of the system prompt. `signal` aborts when the
	 * compaction pass is cancelled or superseded.
	 */
	preCompactionContext?(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
		signal?: AbortSignal,
	): Promise<string | undefined>;

	/**
	 * Optional hook to apply live edits to this backend's own `<id>.*` settings
	 * (`changed` lists them) in a running top-level session. When omitted, the
	 * session re-applies the whole backend (`applyMemoryBackend`), which rebuilds
	 * its runtime state, memory tools, and prompt from the current settings.
	 */
	applySettings?(session: AgentSession, changed: readonly string[]): Promise<void>;
}
