import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { saveLessonToKb, saveManagedSkillRecordToKb } from "../autolearn/kb-sink";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { localBackend } from "../memory-backend/local-backend";
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
 * Backends the `learn` tool can actually store to — each has a real sink in
 * {@link LearnTool.execute}: `mnemopi` SQLite, `local` `learned.md`, `hindsight` the
 * remote outbox, `memvidkb` a record in the knowledge service.
 *
 * Single source of truth on purpose. The tool's own factory and BOTH gates in
 * `tools/index.ts` (the `requestedTools` force-include and `isToolAllowed`) read this
 * one list, because drift between them is silent in the worst way: `learn` is simply
 * never constructed, so auto-learn captures nothing and nothing reddens.
 */
export const LEARN_CAPABLE_BACKENDS: readonly MemoryBackendId[] = ["hindsight", "mnemopi", "local", "memvidkb"];

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
 * backend with a sink — `hindsight`/`mnemopi` (remote/SQLite), `local` (the
 * file-based rollout backend, where lessons append to `learned.md`), or `memvidkb`
 * (a record in the knowledge service; `learned.md` is never written on that path).
 */
export class LearnTool implements AgentTool<LearnSchema> {
	readonly name = "learn";
	/**
	 * A global lesson reaches every project's recall, and a `memvidkb` lesson lands in a
	 * shared central track, so both need the same approval as a file write.
	 */
	readonly approval = (args: unknown) => {
		const params = args as Partial<LearnParams>;
		const backend = cfgMemoryBackend.get(this.session.settings);
		// `memvidkb` included: a central record mutates shared state every project
		// recalls, so it is a write even when the payload is only a lesson.
		return params.skill || params.scope === "global" || backend === "local" || backend === "memvidkb"
			? "write"
			: "read";
	};
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
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new LearnTool(session);
	}

	async execute(toolCallId: string, params: LearnParams): Promise<AgentToolResult> {
		// 1) Persist or queue the lesson to long-term memory (mirrors MemoryRetainTool).
		const backend = cfgMemoryBackend.get(this.session.settings);
		if (params.scope === "global" && backend !== "mnemopi" && backend !== "hindsight") {
			throw new Error(`Global memory scope is not available with the ${backend} memory backend.`);
		}
		let memoryMessage = "Lesson stored";
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}
			// Resolve the target before writing, so an unsupported scoping mode is not reported as a storage failure.
			const target = params.scope === "global" ? state.getGlobalRetainTarget() : undefined;
			// A failed write throws (closed DB / disk error). Fail loudly with the
			// cause rather than reporting (and minting a skill for) a lesson that was
			// never stored.
			try {
				state.rememberScoped(
					params.memory,
					{
						source: "coding-agent-learn",
						importance: 0.8,
						metadata: {
							session_id: state.sessionId,
							cwd: state.session.sessionManager.getCwd(),
							context: params.context ?? null,
							tool: "learn",
						},
						scope: "bank",
						extract: true,
						extractEntities: true,
						veracity: "tool",
						memoryType: "fact",
					},
					target,
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`Mnemopi did not store the lesson: ${reason}`, { cause: error });
			}
		} else if (backend === "local") {
			const result = await localBackend.save?.(
				{ agentDir: this.session.settings.getAgentDir(), cwd: this.session.cwd },
				{ content: params.memory, context: params.context, source: "coding-agent-learn", importance: 0.8 },
			);
			if (!result || result.stored === 0) {
				throw new Error("Lesson was empty after sanitization; nothing stored.");
			}
		} else if (backend === "memvidkb") {
			// The record is the capture's first write, so a refused or unreachable KB
			// throws here — before any managed skill is minted — and an outage can never
			// leave a skill file on disk backing a lesson nobody stored. `learned.md` is
			// never reached on this path: its writer `saveLearnedLesson` has exactly one
			// caller, `localBackend.save`, which the `local` branch above owns.
			const result = await saveLessonToKb(this.session.settings.getAgentDir(), this.session.cwd, {
				memory: params.memory,
				...(params.context === undefined ? {} : { context: params.context }),
			});
			if (result.stored === 0) {
				throw new Error(result.message ?? "Knowledge base did not store the lesson; nothing was sent.");
			}
			// The service names the record it accepted, so the model is told which
			// record backs the lesson rather than only that something was stored.
			const recordId = result.ids?.[0];
			memoryMessage = recordId
				? `Lesson stored in the knowledge base (id ${recordId})`
				: "Lesson stored in the knowledge base";
		} else {
			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}
			// Throws before queueing while global scope is off, has no destination, or the outbox
			// cannot persist the lesson, so no skill is written either.
			await state.enqueueRetain(toolCallId, [
				{ content: params.memory, context: params.context, scope: params.scope },
			]);
			memoryMessage = "Lesson queued for retention";
		}

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
			if (backend === "memvidkb") {
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
