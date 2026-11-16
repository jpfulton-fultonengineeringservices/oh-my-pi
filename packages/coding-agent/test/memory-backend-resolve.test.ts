import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SubmenuOption } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { createMemoryRuntimeContext, resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import {
	RETIRED_MEMORY_BACKENDS,
	cfgMemoryBackend,
	isRetiredMemoryBackend,
	retiredMemoryBackendMessage,
} from "@oh-my-pi/pi-coding-agent/memory-backend/settings";

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
