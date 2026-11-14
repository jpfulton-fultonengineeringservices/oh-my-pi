/** Publish a file by write-then-rename so no reader sees a partial file. */

import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

/** What {@link writeAtomic} can publish at a path. */
export type AtomicWriteData = string | Uint8Array | ArrayBuffer;

/**
 * Publish `data` at `filePath` atomically: stage it in a sibling temp file, then
 * rename over the target. A reader sees the previous bytes or the new ones, never
 * a truncated or half-written file, and parent directories are created on the way.
 *
 * `Bun.write` alone creates the parent directories but publishes in place, so a
 * crash or a concurrent reader mid-flush leaves a partial file at the real path;
 * `rename` within a directory is the atomic step that closes that window. A failed
 * publish leaves the target untouched and removes its own temp file.
 */
export async function writeAtomic(filePath: string, data: AtomicWriteData): Promise<void> {
	const target = path.resolve(filePath);
	const dir = path.dirname(target);
	await fsPromises.mkdir(dir, { recursive: true });
	const temp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
	try {
		await Bun.write(temp, data);
		await fsPromises.rename(temp, target);
	} catch (error) {
		await fsPromises.rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}
