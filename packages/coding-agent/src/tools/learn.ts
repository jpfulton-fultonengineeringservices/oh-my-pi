import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { saveLessonToKb, saveManagedSkillRecordToKb } from "../autolearn/kb-sink";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import type { MemoryBackendId } from "../memory-backend/types";
import learnDescription from "../prompts/tools/learn.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgAutolearnEnabled } from "../autolearn/settings";
import { isGlobalMemoryScopeAvailable } from "../memory-backend/global-scope";
import { cfgMemoryBackend } from "../memory-backend/settings";

const learnSkillSchema = type({
	action: "'create' | 'update'",
	name: type("string").describe("kebab-case skill name"),
	description: type("string").describe("one-line description of when to use the skill"),
	body: type("string").describe("the SKILL.md body in markdown (no frontmatter)"),
}).describe("also create or enhance a managed skill in the same call");

const learnSchemaBase = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"skill?": learnSkillSchema,
});

/** Offered only where every project recalls a global item; see {@link isGlobalMemoryScopeAvailable}. */
const learnSchemaWithScope = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"scope?": type("'project' | 'global'").describe(
		"storage scope; defaults to project, global is for durable cross-project knowledge",
	),
	"skill?": learnSkillSchema,
});

type LearnSchema = typeof learnSchemaBase | typeof learnSchemaWithScope;

export type LearnParams = typeof learnSchemaWithScope.infer;

/**
 * Backends the `learn` tool can actually store to. The only sink left in
 * {@link LearnTool.execute} is `memvidkb`, a record in the knowledge service; the
 * retired ids (`local` `learned.md`, `mnemopi` SQLite, `hindsight` the remote outbox)
 * are absent on purpose, because listing one here mounts `learn` for a config that
 * every other path refuses to start.
 *
 * Single source of truth on purpose. The tool's own factory and BOTH gates in
 * `tools/index.ts` (the `requestedTools` force-include and `isToolAllowed`) read this
 * one list, because drift between them is silent in the worst way: `learn` is simply
 * never constructed, so auto-learn captures nothing and nothing reddens.
 */
export const LEARN_CAPABLE_BACKENDS: readonly MemoryBackendId[] = ["memvidkb"];

/**
 * Whether `learn` may be offered for `backend`. Every gate calls this rather than
 * re-literalising the list; see {@link LEARN_CAPABLE_BACKENDS} for why that matters.
 */
export function isLearnCapableBackend(backend: MemoryBackendId): boolean {
	return LEARN_CAPABLE_BACKENDS.includes(backend);
}

/**
 * Orchestrating "learn" tool: persists a lesson to long-term memory and,
 * given a `skill` payload, mints/enhances a managed skill via the shared
 * `writeManagedSkill` primitive. Gated behind `autolearn.enabled` plus a memory
 * backend with a sink, which after the retirement is only `memvidkb` (a record in the
 * knowledge service; no code path writes `learned.md` any more).
 */
export class LearnTool implements AgentTool<LearnSchema> {
	readonly name = "learn";
	/**
	 * Every reachable `learn` is a write: the only selectable backend is `memvidkb`, whose
	 * record lands in a shared central track every project recalls. (It used to branch on
	 * the raw setting to decide whether the retired `local` file write applied.)
	 */
	readonly approval = (_args: unknown) => "write" as const;
	readonly label = "Learn";
	get description(): string {
		return prompt.render(learnDescription, { globalScope: isGlobalMemoryScopeAvailable(this.session) });
	}
	get parameters(): LearnSchema {
		return isGlobalMemoryScopeAvailable(this.session) ? learnSchemaWithScope : learnSchemaBase;
	}
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Capture a reusable lesson to memory (and optionally a managed skill)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LearnTool | null {
		if (!cfgAutolearnEnabled.get(session.settings)) return null;
		const backend = cfgMemoryBackend.get(session.settings);
		if (!isLearnCapableBackend(backend)) return null;
		return new LearnTool(session);
	}

	async execute(_toolCallId: string, params: LearnParams): Promise<AgentToolResult> {
		// 1) Persist the lesson to long-term memory. Resolved through the selector instead of
		// read off the raw setting: a config left on a retired id has to fail here exactly as
		// the session does, rather than minting `learned.md` through the retired local writer
		// while every other path refuses to start.
		const backend = await resolveMemoryBackend(this.session.settings);
		if (params.scope === "global") {
			throw new Error(`Global memory scope is not available with the ${backend.id} memory backend.`);
		}
		let memoryMessage = "Lesson stored";
		if (backend.id !== "memvidkb") {
			// Unreachable through the selector: `off` never mounts `learn`, and every retired id
			// throws inside `resolveMemoryBackend`. Kept as the assertion that this tool has no
			// storage path outside the knowledge service.
			throw new Error(`The learn tool has no storage path for the ${backend.id} memory backend.`);
		}
		// The record is the capture's first write, so a refused or unreachable KB throws here —
		// before any managed skill is minted — and an outage can never leave a skill file on
		// disk backing a lesson nobody stored. `learned.md` is unreachable from here: its
		// writer `saveLearnedLesson` was called only by `localBackend.save`, which belonged to
		// the retired `local` branch.
		const kbResult = await saveLessonToKb(this.session.settings.getAgentDir(), this.session.cwd, {
			memory: params.memory,
			...(params.context === undefined ? {} : { context: params.context }),
		});
		if (kbResult.stored === 0) {
			throw new Error(kbResult.message ?? "Knowledge base did not store the lesson; nothing was sent.");
		}
		// The service names the record it accepted, so the model is told which
		// record backs the lesson rather than only that something was stored.
		const recordId = kbResult.ids?.[0];
		memoryMessage = recordId
			? `Lesson stored in the knowledge base (id ${recordId})`
			: "Lesson stored in the knowledge base";

		// 2) Optionally mint/enhance a managed skill. A failure here is surfaced
		// as a partial outcome — the lesson is already stored or queued.
		if (params.skill) {
			// A managed skill resolves below any authored skill of the same name, so
			// minting one under a claimed name writes a file that never surfaces. The
			// lesson is already stored/queued; refuse the skill rather than report a
			// false "Created" (mirrors ManageSkillTool).
			let safeSkillName: string | undefined;
			try {
				safeSkillName = sanitizeSkillName(params.skill.name);
			} catch {
				safeSkillName = undefined;
			}
			if (params.skill.action === "create" && safeSkillName && isNameClaimedByAuthoredSkill(safeSkillName)) {
				return {
					content: [
						{
							type: "text",
							text: `${memoryMessage}. Did not create managed skill "${params.skill.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
						},
					],
					isError: true,
					details: { skill: null, shadowed: true },
				};
			}
			try {
				await writeManagedSkill(params.skill);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${memoryMessage}, but the managed skill could not be written: ${reason}`);
			}
			const verb = params.skill.action === "create" ? "Created" : "Updated";
			// A KB-backed skill's record asserts that a skill of this name exists, so it
			// is written only now that the file does. A refusal here is a partial outcome
			// the model is told about, never a silent capture and never a record
			// describing a file nobody minted.
			const backing = await saveManagedSkillRecordToKb(this.session.settings.getAgentDir(), this.session.cwd, {
				name: params.skill.name,
				description: params.skill.description,
				...(params.context === undefined ? {} : { context: params.context }),
			});
			if (backing.stored === 0) {
				throw new Error(
					`${memoryMessage}. ${verb} managed skill "${params.skill.name}", but its knowledge-base backing record was not stored: ${backing.message ?? "nothing was sent."}`,
				);
			}
			try {
				await this.session.refreshSkills?.();
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(
					`${memoryMessage}. ${verb} managed skill "${params.skill.name}", but refreshing session skills failed: ${reason}`,
				);
			}
			return {
				content: [{ type: "text", text: `${memoryMessage}. ${verb} managed skill "${params.skill.name}".` }],
				details: { skill: params.skill.name },
			};
		}

		return {
			content: [{ type: "text", text: `${memoryMessage}.` }],
			details: { skill: null },
		};
	}
}
