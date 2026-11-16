/**
 * Nested skill folders.
 *
 * A skills root may hold *group* directories that contain skills
 * (`skills/<group>/<skill>/SKILL.md`); the operator's flat `cmux-*` tree is the
 * motivating case for the native roots. Two invariants keep bounded descent from
 * inventing skills out of a skill's own assets:
 *
 * 1. a directory that owns a `SKILL.md` IS a skill, so its `references/`,
 *    `templates/`, `assets/` and `examples/` subdirectories are never listed;
 * 2. a group may neither resolve outside the root it was scanned from (one
 *    symlink must not turn a skills directory into a reader for an arbitrary
 *    subtree) nor be listed twice (a link back at an ancestor would otherwise
 *    re-emit every skill beneath it, once per level the depth bound allows).
 *
 * Descent is opt-in via `maxDepth`; leaving it unset preserves the single-level
 * shape every non-native provider documents.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Skill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { MANAGED_SKILLS_PROVIDER_ID } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
// Importing discovery registers all providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import {
	isAgentDirUnderHomeConfigRoot,
	MAX_SKILL_NESTING_DEPTH,
	scanSkillsFromDir,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const PROVIDER_ID = "native";

// setAgentDir() rewrites these; restore them all so later test files see the original resolver.
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"] as const;

/** Write `<base>/<...segments>/SKILL.md` with the frontmatter every root requires. */
function writeSkill(base: string, ...segments: string[]): string {
	const skillDir = path.join(base, ...segments);
	const name = segments[segments.length - 1] ?? "skill";
	fs.mkdirSync(skillDir, { recursive: true });
	const filePath = path.join(skillDir, "SKILL.md");
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} description\n---\n\n${name} body.\n`);
	return filePath;
}

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function symlinkDir(target: string, linkPath: string): void {
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });
	fs.symlinkSync(target, linkPath, "dir");
}

async function scan(dir: string, options: { maxDepth?: number; includeSelf?: boolean } = {}) {
	const ctx: LoadContext = { cwd: dir, home: dir, repoRoot: null };
	return scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "user", ...options });
}

async function loadProviderSkills(providerId: string, ctx: LoadContext): Promise<Skill[]> {
	const provider = getCapability(skillCapability.id)?.providers.find(candidate => candidate.id === providerId);
	if (!provider) throw new Error(`provider ${providerId} missing for ${skillCapability.id}`);
	const result = await (provider.load as (loadContext: LoadContext) => Promise<{ items: Skill[] }>)(ctx);
	return result.items;
}

describe("scanSkillsFromDir nested group descent", () => {
	let tempDir!: string;
	let savedEnv!: Record<(typeof ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-nested-"));
	});

	afterEach(() => {
		clearCache();
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		__resetDirsFromEnvForTests();
		removeSyncWithRetries(tempDir);
	});

	test("resolves a skill inside a group directory", async () => {
		const root = path.join(tempDir, "skills");
		writeSkill(root, "flat-skill");
		writeSkill(root, "cmux", "cmux-backend");
		writeSkill(root, "cmux", "cmux-diagnostics");

		const result = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH });

		expect(result.items.map(skill => skill.name).sort()).toEqual(["cmux-backend", "cmux-diagnostics", "flat-skill"]);
		expect(result.items.find(skill => skill.name === "cmux-backend")?.path).toBe(
			path.join(root, "cmux", "cmux-backend", "SKILL.md"),
		);
	});

	test("without maxDepth the scan stays at the historical single level", async () => {
		// Guards the contract the providers that document a flat layout rely on
		// (`.github/skills`, custom directories, plugin package `skills/`).
		const root = path.join(tempDir, "skills");
		writeSkill(root, "flat-skill");
		writeSkill(root, "group", "nested-skill");

		const result = await scan(root);

		expect(result.items.map(skill => skill.name)).toEqual(["flat-skill"]);
	});

	test("a skill with references/, templates/, assets/ and examples/ subdirectories yields exactly one skill", async () => {
		// The regression a naive recursion introduces: each of these subdirectories
		// carries a SKILL.md of its own (a bundled template or example skill), so an
		// implementation that descends into every directory reports the skill four
		// times over, once per asset folder, under asset-folder names.
		const root = path.join(tempDir, "skills");
		writeSkill(root, "my-skill");
		writeSkill(root, "my-skill", "references");
		writeSkill(root, "my-skill", "templates");
		writeSkill(root, "my-skill", "assets");
		writeSkill(root, "my-skill", "examples", "demo");
		writeFile(path.join(root, "my-skill", "scripts", "run.sh"), "#!/bin/sh\necho hi\n");

		const result = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH });

		expect(result.items.map(skill => skill.name)).toEqual(["my-skill"]);
		expect(result.items[0]?.path).toBe(path.join(root, "my-skill", "SKILL.md"));
	});

	test("bounded descent stops at maxDepth", async () => {
		const root = path.join(tempDir, "skills");
		// A skill directory at level 5 (`g1/g2/g3/g4/deep-skill`) is within the
		// default bound; one more level (`h1/.../h5/too-deep-skill`) is not.
		writeSkill(root, "g1", "g2", "g3", "g4", "deep-skill");
		writeSkill(root, "h1", "h2", "h3", "h4", "h5", "too-deep-skill");

		const bounded = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH });
		expect(bounded.items.map(skill => skill.name)).toEqual(["deep-skill"]);

		const shallower = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH - 1 });
		expect(shallower.items).toEqual([]);
	});

	test("does not re-list a group reached through a symlinked alias", async () => {
		const root = path.join(tempDir, "skills");
		writeSkill(root, "cmux", "cmux-backend");
		symlinkDir(path.join(root, "cmux"), path.join(root, "cmux-alias"));

		const result = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH });

		expect(result.items.map(skill => skill.name)).toEqual(["cmux-backend"]);
	});

	test("terminates when a group symlinks back at the skills root", async () => {
		const root = path.join(tempDir, "skills");
		writeSkill(root, "real-skill");
		// The loop a depth bound alone would only slow down: every level re-lists the
		// root, so each skill under it is emitted once per level.
		symlinkDir(root, path.join(root, "loop"));

		const result = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH });

		expect(result.items.map(skill => skill.name)).toEqual(["real-skill"]);
	});

	test("refuses a group that resolves outside the skills root", async () => {
		const root = path.join(tempDir, "skills");
		const outside = path.join(tempDir, "elsewhere");
		writeSkill(outside, "outside-skill");
		writeSkill(root, "local-skill");
		symlinkDir(outside, path.join(root, "escape"));

		const result = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH });

		expect(result.items.map(skill => skill.name)).toEqual(["local-skill"]);
		expect(result.warnings ?? []).toContain(
			`Skipping skill group that resolves outside its skills root: ${path.join(root, "escape")} -> ${fs.realpathSync(outside)}`,
		);
	});

	test("still loads a symlinked skill directory that resolves outside the root", async () => {
		// Containment governs the descent into groups only. A skill directory that is
		// itself a symlink is the pre-existing shape (a vendored or linked skill pack),
		// and `skill://` reads stay bounded by the skill's own directory.
		const root = path.join(tempDir, "skills");
		const vendored = path.join(tempDir, "vendored");
		writeSkill(vendored, "k8s-ops");
		symlinkDir(path.join(vendored, "k8s-ops"), path.join(root, "k8s-ops"));

		const result = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH });

		expect(result.items.map(skill => skill.name)).toEqual(["k8s-ops"]);
		expect(result.items[0]?.path).toBe(path.join(root, "k8s-ops", "SKILL.md"));
		// The same predicate is what keeps a legitimately-symlinked *skill* from being
		// re-examined as a group at all: the skill branch never reaches the
		// containment guard, so a linked-in skill pack is loaded without a warning.
		expect(result.warnings).toEqual([]);
	});

	test("includeSelf loads the root SKILL.md alongside nested groups", async () => {
		const root = path.join(tempDir, "plugin", "skills");
		writeFile(path.join(root, "SKILL.md"), "---\nname: root-skill\ndescription: root\n---\n\nroot body.\n");
		writeSkill(root, "group", "child-skill");

		const result = await scan(root, { maxDepth: MAX_SKILL_NESTING_DEPTH, includeSelf: true });

		expect(result.items.map(skill => skill.name).sort()).toEqual(["child-skill", "root-skill"]);
	});
});

describe("native skill roots discover nested groups", () => {
	let tempDir!: string;
	let home!: string;
	let project!: string;
	let cwd!: string;
	let savedEnv!: Record<(typeof ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-nested-roots-"));
		home = path.join(tempDir, "home");
		project = path.join(tempDir, "project");
		cwd = path.join(project, "nested");
		fs.mkdirSync(cwd, { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		// The default layout: the agent dir lives under the home config root.
		setAgentDir(path.join(home, ".omp", "agent"));
	});

	afterEach(() => {
		clearCache();
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		__resetDirsFromEnvForTests();
		removeSyncWithRetries(tempDir);
	});

	test("the <ancestor>/.omp/skills root", async () => {
		writeSkill(project, ".omp", "skills", "team", "deploy-runbook");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => [skill.name, skill.level])).toEqual([["deploy-runbook", "project"]]);
		expect(skills[0]?.path).toBe(path.join(project, ".omp", "skills", "team", "deploy-runbook", "SKILL.md"));
	});

	test("the <agentDir>/skills root", async () => {
		writeSkill(home, ".omp", "agent", "skills", "cmux", "cmux-backend");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => [skill.name, skill.level])).toEqual([["cmux-backend", "user"]]);
	});

	test("the managed-skills root", async () => {
		writeSkill(home, ".omp", "agent", "managed-skills", "learned", "triage-flow");

		const skills = await loadProviderSkills(MANAGED_SKILLS_PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => [skill.name, skill.level])).toEqual([["triage-flow", "user"]]);
	});

	test("the ~/.omp/skills root shared by every profile", async () => {
		writeSkill(home, ".omp", "skills", "fulton", "cluster-ops");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => [skill.name, skill.level, skill._source.provider])).toEqual([
			["cluster-ops", "user", PROVIDER_ID],
		]);
	});

	test("the profile agent dir is scanned before ~/.omp/skills on a name collision", async () => {
		// Both roots carry `dupe`. A provider returns what it scanned, unsorted across
		// roots, and the capability dedup is first-wins by name — so the scan order is
		// what decides the survivor, and the profile-specific root must come first.
		const profileSkill = writeSkill(home, ".omp", "agent", "skills", "team", "dupe");
		writeSkill(home, ".omp", "skills", "shared", "dupe");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => [skill.name, skill.path])).toEqual([
			["dupe", profileSkill],
			["dupe", path.join(home, ".omp", "skills", "shared", "dupe", "SKILL.md")],
		]);
	});

	test("an isolated agent dir excludes the ~/.omp/skills root", async () => {
		// `~/.omp` is the operator's config root; a session redirected elsewhere
		// (profile override, PI_CODING_AGENT_DIR, an SDK session carrying its own
		// agentDir) must not load it, exactly as it must not load ~/.omp/SYSTEM.md.
		const isolatedAgentDir = path.join(tempDir, "isolated-agent");
		setAgentDir(isolatedAgentDir);
		writeSkill(home, ".omp", "skills", "shared", "operator-skill");
		writeSkill(isolatedAgentDir, "skills", "session", "session-skill");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => skill.name)).toEqual(["session-skill"]);
	});

	test("a session-carried agentDir outside ~/.omp excludes the ~/.omp/skills root", async () => {
		// The gate must read the session's own agentDir when it carries one: user
		// skills are anchored at `getAgentDir()`, so the session value is only visible
		// through the gate here.
		writeSkill(home, ".omp", "skills", "shared", "operator-skill");
		writeSkill(home, ".omp", "agent", "skills", "profile", "profile-skill");
		const sessionAgentDir = path.join(project, ".omp", "agent");
		fs.mkdirSync(sessionAgentDir, { recursive: true });

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project, agentDir: sessionAgentDir });

		expect(skills.map(skill => skill.name)).toEqual(["profile-skill"]);
	});

	test("a symlinked agent dir under ~/.omp keeps ~/.omp/skills a root", async () => {
		// The operator's real layout: `~/.omp/agent` is a symlink at a vendored config
		// checkout, so the root test must stay lexical.
		const vendored = path.join(tempDir, "vendored-config");
		symlinkDir(vendored, path.join(home, ".omp", "agent"));
		writeSkill(vendored, "skills", "cmux", "cmux-backend");
		writeSkill(home, ".omp", "skills", "shared", "cluster-ops");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => skill.name).sort()).toEqual(["cluster-ops", "cmux-backend"]);
	});

	test("the shared root stays put when the agent dir is a named profile's", async () => {
		// Deliberate scope: `~/.omp/skills` lives in the config root, not under
		// `profiles/<name>/`, so it is the one skill root every profile shares. This
		// is the layout `setProfile("team-a")` produces (agentDir =
		// `<configRoot>/profiles/<name>/agent`), reached through the same
		// `PI_CODING_AGENT_DIR` mechanism it writes, without touching process-global
		// profile state.
		const profileAgentDir = path.join(home, ".omp", "profiles", "team-a", "agent");
		setAgentDir(profileAgentDir);
		writeSkill(profileAgentDir, "skills", "work", "profile-skill");
		writeSkill(home, ".omp", "skills", "shared", "operator-skill");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => skill.name).sort()).toEqual(["operator-skill", "profile-skill"]);
		expect(skills.find(skill => skill.name === "profile-skill")?.path).toBe(
			path.join(profileAgentDir, "skills", "work", "profile-skill", "SKILL.md"),
		);
	});

	test("the shared root follows PI_CONFIG_DIR instead of a hardcoded .omp", async () => {
		// `~/.omp/skills` is spelled through `getConfigDirName()`, so a relocated
		// config layout moves it along with the agent dir — and a stale `.omp`
		// beside it stays unread.
		process.env.PI_CONFIG_DIR = ".customcfg";
		const customAgentDir = path.join(home, ".customcfg", "agent");
		setAgentDir(customAgentDir);
		writeSkill(customAgentDir, "skills", "mine", "custom-skill");
		writeSkill(home, ".customcfg", "skills", "shared", "custom-shared-skill");
		writeSkill(home, ".omp", "skills", "shared", "stale-dot-omp-skill");

		const skills = await loadProviderSkills(PROVIDER_ID, { cwd, home, repoRoot: project });

		expect(skills.map(skill => skill.name).sort()).toEqual(["custom-shared-skill", "custom-skill"]);
	});
});

describe("isAgentDirUnderHomeConfigRoot", () => {
	const home = path.join(path.sep, "home", "op");
	const configRoot = path.join(home, ".omp");

	test("admits an agent dir beneath the config root", () => {
		expect(isAgentDirUnderHomeConfigRoot(home, path.join(configRoot, "agent"))).toBe(true);
		// Named profiles live deeper but still inside the config root.
		expect(isAgentDirUnderHomeConfigRoot(home, path.join(configRoot, "profiles", "team-a", "agent"))).toBe(true);
	});

	test("refuses the config root itself and anything outside it", () => {
		// The degenerate override would double-scan `<configRoot>/skills`, which the
		// agent-dir root already reads as `<agentDir>/skills`.
		expect(isAgentDirUnderHomeConfigRoot(home, configRoot)).toBe(false);
		expect(isAgentDirUnderHomeConfigRoot(home, path.join(home, "elsewhere", "agent"))).toBe(false);
		expect(isAgentDirUnderHomeConfigRoot(home, path.join(path.sep, "srv", "omp", "agent"))).toBe(false);
	});

	test("honors PI_CONFIG_DIR for the boundary", () => {
		const saved = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = ".customcfg";
		try {
			const customRoot = path.join(home, ".customcfg");
			expect(isAgentDirUnderHomeConfigRoot(home, path.join(customRoot, "agent"))).toBe(true);
			expect(isAgentDirUnderHomeConfigRoot(home, path.join(home, ".omp", "agent"))).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = saved;
		}
	});
});
