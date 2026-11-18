import type { Settings } from "../config/settings";
import { offBackend } from "./off-backend";
import { cfgMemoryBackend, isRetiredMemoryBackend, retiredMemoryBackendMessage } from "./settings";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes through this):
 *   - `memory.backend === "memvidkb"` → central memvid-kb-rs knowledge service
 *   - `memory.backend === "off"`      → no-op
 *   - anything else                   → no-op
 *
 * The remaining ids the setting still declares (`local`, `hindsight`, `mnemopi`,
 * `sharpshooter`) are retired: they raise {@link retiredMemoryBackendMessage} rather
 * than resolving to whichever backend happens to be the default. Falling back would
 * leave a session believing it was on the retired path while a different store
 * answered its reads and writes.
 *
 * A value *stored* in a config file no longer reaches the throw: `config/settings.ts` normalises a
 * stored retired id to `off` while loading, so such a config boots with no memory subsystem and the
 * operator reads the migration notice. What this still refuses is a retired id supplied at runtime
 * — a `/settings` or `set_command` write, a session overlay — which is exactly where a silent
 * substitution would go unnoticed.
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 *
 * @throws Error when the setting still names a retired backend at resolve time — a runtime write;
 * a value stored in a config file has already been migrated to `off`.
 */
export async function resolveMemoryBackend(settings: Settings): Promise<MemoryBackend> {
	const id = cfgMemoryBackend.get(settings);
	if (isRetiredMemoryBackend(id)) throw new Error(retiredMemoryBackendMessage(id));
	if (id === "memvidkb") return (await import("../memvidkb/backend")).memvidkbBackend;
	return offBackend;
}
