import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SubmenuOption } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { createMemoryRuntimeContext, offBackend, resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import {
	RETIRED_MEMORY_BACKENDS,
	cfgMemoryBackend,
	isLiveMemoryBackend,
	isRetiredMemoryBackend,
	retiredMemoryBackendMessage,
} from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("resolves the two supported selections, and memvidkb when nothing is configured", async () => {
		// The retirement flipped the default: an operator who never chose a backend is on
		// the knowledge service, not on the retired rollout-summary pipeline. It stays inert
		// until the workspace resolves a `.memvidkb`, so the default alone reaches no service.
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "memvidkb" }))).id).toBe("memvidkb");
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "off" }))).id).toBe("off");
		expect((await resolveMemoryBackend(Settings.isolated({}))).id).toBe("memvidkb");
	});

	it("refuses every retired backend instead of resolving it to another backend", async () => {
		// The failure mode this guards is a silent substitution: falling through to `off`
		// (or to the default) would leave the operator believing Hindsight was still
		// recording, while a different store — or nothing — answered their calls.
		for (const retired of RETIRED_MEMORY_BACKENDS) {
			const settings = Settings.isolated({ "memory.backend": retired });
			await expect(resolveMemoryBackend(settings)).rejects.toThrow(retiredMemoryBackendMessage(retired));
		}
	});

	it("names the retired id, its replacement, and both supported selections in the refusal", () => {
		// The message is the operator's only instruction, so it has to be actionable on
		// its own: what went away, what replaced it, and exactly what to set instead.
		for (const retired of RETIRED_MEMORY_BACKENDS) {
			const message = retiredMemoryBackendMessage(retired);
			expect(message).toContain(`memory.backend: "${retired}" is retired`);
			expect(message).toContain("memvid-kb-rs knowledge service");
			expect(message).toContain('Set memory.backend to "memvidkb"');
			expect(message).toContain('or "off" to disable memory');
			expect(message).toContain(`Nothing was substituted for "${retired}"`);
			// Naming a *different* backend would make the operator chase the wrong setting.
			for (const other of RETIRED_MEMORY_BACKENDS) {
				if (other === retired) continue;
				expect(message).not.toContain(`"${other}"`);
			}
		}
	});

	it("keeps the retired selection visible to a direct reader while the selector refuses it", async () => {
		// `values` deliberately still declares the retired ids. Removing them would make
		// the registry's warn-and-default path hand every direct reader of
		// `cfgMemoryBackend.get` the default, so the config would read as `memvidkb` while
		// the operator still has `hindsight` in config.yml — the exact silent fallback the
		// retirement exists to prevent. The refusal therefore happens in the selector only.
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		expect(cfgMemoryBackend.get(settings)).toBe("hindsight");
		await expect(resolveMemoryBackend(settings)).rejects.toThrow(/"hindsight" is retired/);
	});

	it("classifies retired ids without catching the supported ones or a non-string", () => {
		for (const retired of RETIRED_MEMORY_BACKENDS) expect(isRetiredMemoryBackend(retired)).toBe(true);
		expect(isRetiredMemoryBackend("off")).toBe(false);
		expect(isRetiredMemoryBackend("memvidkb")).toBe(false);
		// A malformed config value must not be reported as a retired backend: the reader
		// would be told to migrate from a backend it never named.
		expect(isRetiredMemoryBackend(undefined)).toBe(false);
		expect(isRetiredMemoryBackend(null)).toBe(false);
		expect(isRetiredMemoryBackend(42)).toBe(false);
		expect(isRetiredMemoryBackend({ id: "local" })).toBe(false);
	});

	it("offers only the supported selections in the settings panel while still declaring the retired ids", () => {
		// The panel is the interactive selector: retired backends must not be pickable.
		// The declared vocabulary stays wide so a retired config remains observable (see
		// the case above), which is why these two lists are asserted to differ.
		// An enum setting must offer a concrete list, not a runtime-populated one: the
		// retired ids are absent from the list the panel actually renders.
		const options = cfgMemoryBackend.ui?.options;
		expect(Array.isArray(options)).toBe(true);
		const offered = (options as ReadonlyArray<SubmenuOption>).map(option => option.value);
		expect(offered).toEqual(["off", "memvidkb"]);
		expect(cfgMemoryBackend.enumValues).toEqual(["off", ...RETIRED_MEMORY_BACKENDS, "memvidkb"]);
	});

	it("refuses a retired backend through the runtime context the /memory commands use", async () => {
		// `/memory stats`, `/memory search` and the save/list/edit verbs all resolve the
		// backend themselves. A retired selection must fail there too rather than report
		// an inactive `off` backend the operator would read as "memory is empty".
		for (const retired of RETIRED_MEMORY_BACKENDS) {
			const memory = createMemoryRuntimeContext({
				agentDir: "/tmp/agent",
				cwd: "/tmp/project",
				session: { settings: Settings.isolated({ "memory.backend": retired }) } as never,
			});
			const expected = retiredMemoryBackendMessage(retired);
			await expect(memory.status()).rejects.toThrow(expected);
			await expect(memory.search("anything")).rejects.toThrow(expected);
			await expect(memory.save("a lesson")).rejects.toThrow(expected);
			await expect(memory.list()).rejects.toThrow(expected);
			await expect(memory.edit({ op: "forget", id: "whatever" })).rejects.toThrow(expected);
		}
	});

	it("exposes inactive status when no session is available", async () => {
		const memory = createMemoryRuntimeContext({ agentDir: "/tmp/agent", cwd: "/tmp/project" });

		await expect(memory.status()).resolves.toMatchObject({
			backend: "off",
			active: false,
			writable: false,
			searchable: false,
		});
	});

	it("reports listing and editing as unavailable for a backend that serves neither verb", async () => {
		// The two verbs `memvidkb` added to the `MemoryBackend` interface are optional: every
		// backend that predates them must still resolve, and a caller that asks one for a
		// listing gets a named refusal rather than an empty page it could mistake for "empty".
		const settings = Settings.isolated({ "memory.backend": "off" });
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: { settings } as never,
		});

		const listed = await memory.list();
		expect(listed).toMatchObject({ backend: "off", count: 0, items: [] });
		expect(listed.message).toContain("not available for the off backend");

		const edited = await memory.edit({ op: "forget", id: "whatever" });
		expect(edited).toMatchObject({ backend: "off", status: "unsupported" });
		expect(edited.message).toContain("not available for the off backend");

		const saved = await memory.save("a lesson");
		expect(saved).toMatchObject({ backend: "off", stored: 0 });
		expect(saved.message).toContain("not available for the off backend");

		const searched = await memory.search("project preference");
		expect(searched).toMatchObject({ backend: "off", count: 0, items: [] });
		expect(searched.message).toContain("not available for the off backend");
	});
});

/**
 * The load half of the retirement. A retired id an operator *stored* is not a choice being made
 * now, so it must not take the session down with it: `#migrateRawSettings` normalises it to `off`
 * before the selector ever sees it, the session boots with no memory subsystem, and startup logs
 * what to change. The same id written at runtime is still refused. Both halves are pinned because
 * the difference between them is one flag (`storedOnDisk`) on a single shared migration path.
 */
describe("a config stored on a retired memory backend", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let configPath: string;

	beforeEach(() => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-retired-backend-config-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		configPath = path.join(agentDir, "config.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await tempDir?.remove();
	});

	const load = () => Settings.loadIsolated({ cwd: projectDir, agentDir });
	const retiredNotices = (spy: { mock: { calls: readonly (readonly unknown[])[] } }, needle: string) =>
		spy.mock.calls.map(call => String(call[0])).filter(message => message.includes(needle));

	for (const retired of RETIRED_MEMORY_BACKENDS) {
		it(`boots a config stored on ${retired} with no memory subsystem instead of failing to start`, async () => {
			await Bun.write(configPath, YAML.stringify({ memory: { backend: retired } }, null, 2));
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const settings = await load();

			// The selector sees `off`, so session creation — which awaits the resolve inside
			// `rebuildSystemPrompt` with nothing catching it — reaches a backend instead of throwing.
			expect(cfgMemoryBackend.get(settings)).toBe("off");
			await expect(resolveMemoryBackend(settings)).resolves.toBe(offBackend);

			// Silence would read as "memory quietly stopped working": the notice names the id, what
			// replaced it, and the two values to choose between, exactly once per load.
			const notices = retiredNotices(warn, `memory.backend: "${retired}"`);
			expect(notices).toHaveLength(1);
			expect(notices.join("\n")).toContain("memvidkb");
		});
	}

	it("migrates the quoted-dotted leaf form as well as the nested block", async () => {
		// YAML and the legacy JSON layer both allow a quoted dotted key, and the reader follows only
		// the nested path. Leaving that form unmigrated would hand the operator the `memvidkb`
		// default — a network knowledge service switched on for someone who had named a retired store.
		await Bun.write(configPath, '"memory.backend": hindsight\n');
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const settings = await load();

		expect(cfgMemoryBackend.get(settings)).toBe("off");
		await expect(resolveMemoryBackend(settings)).resolves.toBe(offBackend);
		expect(retiredNotices(warn, 'memory.backend: "hindsight"')).toHaveLength(1);
	});

	it("lets the nested block win over a stale dotted leaf, as every sibling migration does", async () => {
		await Bun.write(
			configPath,
			YAML.stringify({ memory: { backend: "memvidkb" }, "memory.backend": "hindsight" }, null, 2),
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const settings = await load();

		expect(cfgMemoryBackend.get(settings)).toBe("memvidkb");
		expect(retiredNotices(warn, "is retired")).toHaveLength(0);
	});

	it("leaves the file alone until a save is due, then persists `off` and stops noticing", async () => {
		await Bun.write(configPath, YAML.stringify({ memory: { backend: "sharpshooter" } }, null, 2));
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = await load();

		// Migration is read-time normalisation, not a rewrite: the file still names the retired id,
		// which is why the notice repeats at each launch until the operator saves. Landing on `off`
		// silently behind their back would leave a config that no longer says what it once did.
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ memory: { backend: "sharpshooter" } });
		expect(retiredNotices(warn, 'memory.backend: "sharpshooter"')).toHaveLength(1);

		// The first save carries the migrated value with it, and the result is no longer migration
		// input — the migration's own output must not re-notice, or the operator is told the same
		// thing again on the launch after they acted on it.
		cfgMemoryBackend.set(settings, "off");
		await settings.flush();
		const saved = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(saved.memory).toEqual({ backend: "off" });

		warn.mockClear();
		const reloaded = await load();
		expect(cfgMemoryBackend.get(reloaded)).toBe("off");
		expect(retiredNotices(warn, "is retired")).toHaveLength(0);
	});

	it("still refuses the same id when a caller writes it at runtime", async () => {
		// The other half of `storedOnDisk`. An override layer is a value being chosen now — a
		// `/settings` or `set_command` write, a session overlay — so the selector's refusal has to
		// stay reachable; migrating it too would turn every refused write into a silent `off`.
		for (const retired of RETIRED_MEMORY_BACKENDS) {
			const settings = Settings.isolated({ "memory.backend": retired });
			expect(cfgMemoryBackend.get(settings)).toBe(retired);
			await expect(resolveMemoryBackend(settings)).rejects.toThrow(retiredMemoryBackendMessage(retired));
		}
	});
});

describe("isLiveMemoryBackend", () => {
	it("answers from the declaration, never by throwing at an undeclared value", () => {
		expect(isLiveMemoryBackend("memvidkb")).toBe(true);
		for (const retired of RETIRED_MEMORY_BACKENDS) expect(isLiveMemoryBackend(retired)).toBe(false);
		// `off` is not a backend, so it mounts nothing — the same answer a retired id gives, for a
		// different reason that the mount gates must not have to care about.
		expect(isLiveMemoryBackend("off")).toBe(false);
		// A value the registry warn-and-defaulted away from never arrives here as a backend, but the
		// predicate is total: an id no one declared answers `false` rather than throwing on a list
		// that does not contain it, and a mount gate must never be able to take a session down.
		expect(isLiveMemoryBackend("vectorize")).toBe(false);
		expect(isLiveMemoryBackend("")).toBe(false);
		expect(isLiveMemoryBackend(undefined)).toBe(false);
		expect(isLiveMemoryBackend(null)).toBe(false);
		expect(isLiveMemoryBackend(7)).toBe(false);
		expect(isLiveMemoryBackend(["memvidkb"])).toBe(false);
	});
});
