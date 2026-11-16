/**
 * Auto-learn's capture sink for the native `memvidkb` memory backend.
 *
 * Where a capture lands is decided by the resolved backend id and nothing else.
 * `memory.backend: "local"` keeps the file sink: `learned.md` under the project's
 * memory root, appended by {@link saveLearnedLesson}, whose only caller is
 * `localBackend.save`. The `memvidkb` backend does not route through that function,
 * so with `memvidkb` selected no code path reaches `learned.md` — the file stays the
 * local backend's store and never becomes a second copy of what this sink writes.
 *
 * A capture here becomes central state instead, in the two shapes the operator chose:
 *  - a **fact** is one record in the track `selectDefaultTrack` picks, carrying the
 *    same injection-neutralized, secret-redacted, length-bounded text the file sink
 *    writes (both sinks take that chain through the same `normalizeLearnedText` in
 *    `../memories`, so a capture is never safer on one path than the other — the
 *    record is recalled and re-injected into later prompts just as the file block is);
 *  - a **procedure** stays a managed skill on disk, written only through the guarded
 *    `writeManagedSkill` primitive (name allowlist, byte cap, symlink/hardlink
 *    rejection — never a raw name join), and then gets its own record so recall can
 *    surface it the way it surfaces any other record.
 *
 * Ordering is what keeps the pair honest, and it is not interchangeable: the skill
 * file is minted first and the backing record is written only after it exists, so a
 * record can never describe a skill that was never minted; and the lesson record is
 * the FIRST write of a capture, so a refused or unreachable KB leaves the filesystem
 * untouched rather than half-captured.
 */

import { sanitizeSkillName } from "./managed-skills";
import { memvidkbBackend } from "../memvidkb/backend";
import { KNOWLEDGE_ERROR_PREFIX } from "../memvidkb/errors";
import { normalizeLearnedLesson } from "../memories";
import type { MemoryBackendSaveInput, MemoryBackendSaveResult } from "../memory-backend/types";

/**
 * Names the producer of every record this sink writes. The route requires a
 * non-empty `originActor` and never derives one from the bearer, so the capture
 * states who wrote it instead of leaving the service to guess.
 */
export const KB_CAPTURE_SOURCE = "coding-agent-learn";

/** One `learn` fact capture, before normalization. */
export interface KbLessonCapture {
	/** The durable lesson text. */
	readonly memory: string;
	/** Optional source context, carried as the record's display title. */
	readonly context?: string;
}

/** One managed-skill capture, named by the skill file that was just minted. */
export interface KbSkillCapture {
	/** Managed-skill name, already through `sanitizeSkillName` at the file write. */
	readonly name: string;
	/** One-line "when to use" text from the same payload that produced the frontmatter. */
	readonly description: string;
	/** Optional source context, carried as the record's display title. */
	readonly context?: string;
}

/** Nothing this sink can send: an absent `save`, or a capture with no text in it. */
function refused(reason: string): MemoryBackendSaveResult {
	return { backend: "memvidkb", stored: 0, message: `${KNOWLEDGE_ERROR_PREFIX.unavailable}${reason}` };
}

async function saveRecord(
	agentDir: string,
	cwd: string,
	input: MemoryBackendSaveInput,
): Promise<MemoryBackendSaveResult> {
	const normalized = normalizeLearnedLesson(input);
	if (normalized.content.length === 0) {
		return refused("capture refused the request before sending it: lesson was empty after sanitization.");
	}
	const save = memvidkbBackend.save;
	if (save === undefined) {
		return refused("the memvidkb backend exposes no save(); nothing was sent, queued, or stored locally.");
	}
	// No capture sends `importance`, and neither capture type above has such a field —
	// deliberately, not by omission. `RememberRequest` documents no field for it, so the
	// backend answers a defined value with "Not sent — the route documents no field for
	// it: importance." instead of storing it; and the file sink never read it either
	// (`saveLearnedLesson` only normalizes it through). Leaving it out keeps a result
	// `message` reserved for real refusals rather than a field no route can carry.
	return save({ agentDir, cwd }, normalized);
}

/**
 * Store one fact as a knowledge-base record.
 *
 * @param agentDir - Agent directory of the capturing session.
 * @param cwd - Workspace root the upward `.memvidkb` search starts from.
 * @param capture - Lesson text and optional context.
 * @returns The backend's save result; `stored === 0` always carries a prefixed
 * `message` naming why, and a failure means the service stored nothing.
 */
export async function saveLessonToKb(
	agentDir: string,
	cwd: string,
	capture: KbLessonCapture,
): Promise<MemoryBackendSaveResult> {
	return saveRecord(agentDir, cwd, {
		content: capture.memory,
		...(capture.context === undefined ? {} : { context: capture.context }),
		source: KB_CAPTURE_SOURCE,
	});
}

/**
 * Back a managed skill with its own knowledge-base record.
 *
 * Call this only once the skill file exists: the record asserts that a skill of
 * this name was minted, so writing it first would let central memory describe a
 * file that was never created. The name goes through `sanitizeSkillName` again
 * here — the same allowlist `writeManagedSkill` applied — so the text that names
 * the skill is the skill's real directory name and cannot carry a path.
 *
 * @param agentDir - Agent directory of the capturing session.
 * @param cwd - Workspace root the upward `.memvidkb` search starts from.
 * @param capture - Skill name, its one-line description, and optional context.
 * @returns The backend's save result, with the same `stored === 0` contract.
 */
export async function saveManagedSkillRecordToKb(
	agentDir: string,
	cwd: string,
	capture: KbSkillCapture,
): Promise<MemoryBackendSaveResult> {
	const name = sanitizeSkillName(capture.name);
	const description = capture.description.trim();
	const content = description.length > 0 ? `managed skill "${name}": ${description}` : `managed skill "${name}"`;
	return saveRecord(agentDir, cwd, {
		content,
		...(capture.context === undefined ? {} : { context: capture.context }),
		source: KB_CAPTURE_SOURCE,
	});
}
