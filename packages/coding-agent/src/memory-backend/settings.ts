/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

/**
 * Memory backends retired by the memvid-kb-rs cutover: the local rollout summary
 * pipeline and the three third-party stores it replaces.
 *
 * Retired means *unreachable through the single selector*: the settings panel no
 * longer offers the value, and {@link resolveMemoryBackend} refuses it with
 * {@link retiredMemoryBackendMessage} instead of quietly handing back a different
 * backend. The retired implementations and their settings deliberately stay in the
 * tree (deleting them is a separate change), so `MemoryBackendId` still names every
 * id and each backend's own unit tests still construct it directly.
 */
export const RETIRED_MEMORY_BACKENDS = ["local", "hindsight", "mnemopi", "sharpshooter"] as const;

/** One retired memory backend id. */
export type RetiredMemoryBackendId = (typeof RETIRED_MEMORY_BACKENDS)[number];

/** What replaced each retired backend, in the words an operator acts on. */
const RETIRED_MEMORY_BACKEND_NOTES: Record<RetiredMemoryBackendId, string> = {
	local: "the local rollout summarisation pipeline (memory_summary.md) has been replaced by the memvid-kb-rs knowledge service",
	hindsight:
		"the Vectorize Hindsight remote memory service has been replaced by the memvid-kb-rs knowledge service; nothing is deleted server-side, but omp no longer talks to it",
	mnemopi:
		"the local Mnemopi SQLite backend (formerly `mnemosyne`) has been replaced by the memvid-kb-rs knowledge service",
	sharpshooter:
		"the Sharpshooter friction-gated project-decision backend has been replaced by the memvid-kb-rs knowledge service",
};

/** Whether `value` names a retired memory backend. */
export function isRetiredMemoryBackend(value: unknown): value is RetiredMemoryBackendId {
	return typeof value === "string" && (RETIRED_MEMORY_BACKENDS as readonly string[]).includes(value);
}

/**
 * The refusal for a config that still selects a retired backend: names the retired id,
 * says what replaced it, and names both supported selections.
 *
 * A retired id must never resolve to another backend silently — the operator would go
 * on believing the retired path was active while a different store answered their
 * `retain`/`recall` calls. Nothing runs in its place: the session disposes the memory
 * state and unmounts the memory tools when this throws.
 */
export function retiredMemoryBackendMessage(backend: RetiredMemoryBackendId): string {
	return (
		`memory.backend: "${backend}" is retired — ${RETIRED_MEMORY_BACKEND_NOTES[backend]}. ` +
		`Set memory.backend to "memvidkb" (the memvid-kb-rs knowledge service, configured through the ` +
		`workspace's .memvidkb) or "off" to disable memory. Nothing was substituted for "${backend}"; ` +
		"no memory backend is running until you choose one."
	);
}

// Memory backend selector — picks between the central memvid-kb-rs knowledge service
// and off. The legacy `memories.enabled` flag is migration input only; see
// config/settings.ts. Protocol hosts (RPC/ACP) start from this setting's default
// (memvidkb), which stays inert until the workspace resolves a `.memvidkb` and its
// bearer token, so an embedder never reaches a knowledge service it did not opt into.
//
// `values` keeps the retired ids on purpose. The registry reads a value outside
// `values` as the default (config/registry.ts `compute`, warn-and-default), and memory
// consumers read this setting directly as well as through `resolveMemoryBackend`
// (`tools/index.ts`, `internal-urls/memory-protocol.ts`, `memories/index.ts`). Dropping
// the ids here would make each of those readers see `memvidkb` where the config says
// `hindsight` — the silent fallback this retirement exists to prevent. Keeping them
// makes the configured value observable everywhere and concentrates the refusal in the
// one selector, which throws.
export const cfgMemoryBackend = register({
	id: "memory.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "local", "hindsight", "mnemopi", "sharpshooter", "memvidkb"] as const,
	default: "memvidkb",
	ui: {
		tab: "memory",
		group: "General",
		label: "Memory Backend",
		description:
			"Off, or the memvid-kb-rs knowledge service. The local summary pipeline, Mnemopi, Hindsight and Sharpshooter backends are retired and are refused by memory.backend.",
		options: [
			{ value: "off", label: "Off", description: "No memory subsystem runs" },
			{
				value: "memvidkb",
				label: "MemvidKB",
				description: "Central memvid-kb-rs knowledge service, reached through the workspace's .memvidkb",
			},
		],
	},
});
