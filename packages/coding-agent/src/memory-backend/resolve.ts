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
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 *
 * @throws Error when the config still selects a retired backend.
 */
export async function resolveMemoryBackend(settings: Settings): Promise<MemoryBackend> {
	const id = cfgMemoryBackend.get(settings);
	if (isRetiredMemoryBackend(id)) throw new Error(retiredMemoryBackendMessage(id));
	if (id === "memvidkb") return (await import("../memvidkb/backend")).memvidkbBackend;
	return offBackend;
}
