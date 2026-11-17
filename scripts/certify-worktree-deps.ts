#!/usr/bin/env bun
/**
 * Certify (and, on request, create) a per-worktree `node_modules` for this repo.
 *
 * Why this exists: git worktrees created by the farm inherit NO `node_modules`,
 * and a convenience symlink `<worktree>/node_modules -> <main checkout>/node_modules`
 * is silently wrong for this repo. Every `@oh-my-pi/*` package is a workspace link
 * whose relative target resolves from the *link's own directory*, so through that
 * symlink every cross-package import in a worktree test run loads the **main
 * checkout's `packages/`** while same-package relative imports (`../src/...`) load the
 * worktree's branch code. The two copies of a module get separate records, so a
 * module-level singleton (e.g. `packages/utils/src/worker-host.ts` `workerHostMain`)
 * is written in one copy and read from the other — tests then fail (or pass) for
 * reasons that have nothing to do with the branch under test.
 *
 * `--check` (default) asserts the tree is safe to measure and exits nonzero with the
 * reasons; it never repairs, so a gate/battery can depend on it as a provenance gate.
 * `--wire` creates a real `<worktree>/node_modules`: third-party entries link into the
 * main checkout's install, and every `@oh-my-pi/*` entry is an ABSOLUTE link into THIS
 * tree's `packages/` (relative targets under a symlinked holder resolve to the wrong tree).
 * It also mirrors any per-package `node_modules` the main checkout has.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const wire = process.argv.includes("--wire");
const problems: string[] = [];

const git = (args: string[]): string => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
/**
 * Which checkout holds the install to borrow third-party packages from.
 *
 * `git worktree list --porcelain` cannot be taken at face value here: for a
 * submodule whose gitdir was moved under the parent's `.git/modules`, its first
 * entry is that gitdir, not a checkout. So keep only entries that are actually
 * a root of this repo, drop the ones that live inside this tree (farm
 * worktrees sit under `.git-worktrees/`), and prefer the survivor that is not
 * such a worktree - the main checkout, whose `bun install` is canonical.
 */
const checkoutRoots = git(["worktree", "list", "--porcelain"])
	.split("\n")
	.filter(l => l.startsWith("worktree "))
	.map(l => l.slice("worktree ".length).trim())
	.filter(p => fs.existsSync(path.join(p, "package.json")) && fs.existsSync(path.join(p, "packages", "coding-agent")));
// The canonical install lives in the checkout that is neither a farm worktree
// nor a scratch tree under `.git-worktrees/`, and that has been installed.
// Nested copies of this tree (a sandbox clone inside a worktree) never win.
const candidates = checkoutRoots.filter(
	p => path.resolve(p) !== path.resolve(repoRoot) || fs.existsSync(path.join(p, "node_modules")),
);
const mainRoot =
	candidates.find(p => !p.includes(".git-worktrees") && fs.existsSync(path.join(p, "node_modules"))) ??
	candidates.find(p => !p.includes(".git-worktrees")) ??
	// A lone checkout (no sibling worktrees registered) certifies against its own
	// install; the absence of one is reported below as a missing install, not as
	// a failure to find some other checkout.
	repoRoot;
const isWorktree = path.resolve(mainRoot) !== path.resolve(repoRoot);
const mainNm = path.join(mainRoot, "node_modules");
const nm = path.join(repoRoot, "node_modules");

const lstat = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false });

function mirrorEntries(holder: string, srcNm: string, treeBase: string): number {
	fs.mkdirSync(holder, { recursive: true });
	let linked = 0;
	for (const name of fs.readdirSync(srcNm)) {
		if (name === "@oh-my-pi" || name === ".bin" || name === ".cache") continue;
		const dst = path.join(holder, name);
		if (lstat(dst)) continue;
		const src = path.join(srcNm, name);
		fs.symlinkSync(src, dst, fs.lstatSync(src).isDirectory() ? "dir" : "file");
		linked++;
	}
	// Workspace packages must resolve inside the tree being measured, never through the main checkout.
	const srcOh = path.join(srcNm, "@oh-my-pi");
	if (fs.existsSync(srcOh)) {
		const holderOh = path.join(holder, "@oh-my-pi");
		fs.mkdirSync(holderOh, { recursive: true });
		for (const name of fs.readdirSync(srcOh)) {
			const rel = fs.readlinkSync(path.join(srcOh, name)); // ../../packages/<dir>
			const target = path.join(treeBase, rel.replace(/^(\.\.\/)+/, ""));
			if (!fs.existsSync(target)) {
				problems.push(`@oh-my-pi/${name}: no package dir at ${target}`);
				continue;
			}
			const dst = path.join(holderOh, name);
			if (lstat(dst)) fs.unlinkSync(dst);
			fs.symlinkSync(target, dst, "dir");
			linked++;
		}
	}
	return linked;
}

// `--wire` needs something to borrow third-party entries from; refuse loudly
// rather than produce a half-populated tree.
if (wire && isWorktree && !fs.existsSync(mainNm)) {
	console.error(`certify-worktree-deps: main checkout has no node_modules at ${mainNm}; run bun install there first`);
	process.exit(2);
}

const st = lstat(nm);
if (wire) {
	if (st?.isSymbolicLink()) {
		const backup = path.join(repoRoot, ".node_modules-symlink-target.txt");
		fs.writeFileSync(backup, fs.readlinkSync(nm) + "\n");
		fs.unlinkSync(nm);
		console.log(`certify-worktree-deps: removed node_modules symlink (target saved to ${backup})`);
	}
	const linked = mirrorEntries(nm, mainNm, repoRoot);
	console.log(`certify-worktree-deps: wired ${repoRoot}/node_modules with ${linked} entries`);
	for (const d of fs.readdirSync(path.join(repoRoot, "packages"))) {
		const srcPkgNm = path.join(mainRoot, "packages", d, "node_modules");
		if (!fs.existsSync(srcPkgNm) || !lstat(srcPkgNm)?.isDirectory()) continue;
		const dstPkgNm = path.join(repoRoot, "packages", d, "node_modules");
		if (lstat(dstPkgNm)?.isSymbolicLink()) fs.unlinkSync(dstPkgNm);
		mirrorEntries(dstPkgNm, srcPkgNm, repoRoot);
	}
} else if (!st) {
	problems.push(`node_modules missing at ${nm}`);
} else if (st.isSymbolicLink()) {
	problems.push(
		`node_modules is a symlink -> ${fs.readlinkSync(nm)} (cross-package imports would load the link target's sources)`,
	);
}

if (!problems.length && fs.existsSync(nm)) {
	const treeReal = fs.realpathSync(repoRoot) + path.sep;
	const holder = path.join(nm, "@oh-my-pi");
	if (!fs.existsSync(holder)) {
		problems.push("node_modules/@oh-my-pi holder missing");
	} else {
		for (const name of fs.readdirSync(holder)) {
			const real = fs.realpathSync(path.join(holder, name));
			if (!real.startsWith(treeReal)) problems.push(`@oh-my-pi/${name} resolves outside this tree -> ${real}`);
		}
	}
	for (const spec of ["@oh-my-pi/pi-coding-agent/config/settings", "@oh-my-pi/pi-utils/worker-host"]) {
		let resolved = "";
		try {
			resolved = Bun.resolveSync(spec, path.join(repoRoot, "packages", "coding-agent"));
		} catch (error) {
			problems.push(`${spec}: ${(error as Error).message}`);
			continue;
		}
		// `Bun.resolveSync` hands back a plain path here, not a `file://` URL, and
		// may return it through a symlinked prefix - canonicalize both sides before
		// asking whether the target lives in this tree.
		const resolvedReal = resolved.replace(/^file:\/\//, "");
		if (!fs.existsSync(resolvedReal) || !fs.realpathSync(resolvedReal).startsWith(treeReal))
			problems.push(`${spec} resolved outside this tree: ${resolved}`);
	}
	const addon = path.join(
		repoRoot,
		"packages",
		"natives",
		"native",
		`pi_natives.${process.platform === "win32" ? "win32-x64.node" : `${process.platform}-${process.arch}.node`}`,
	);
	if (!fs.existsSync(addon)) problems.push(`native addon missing at ${addon}`);
}

const nmKind = !st ? "MISSING" : st.isSymbolicLink() ? "SYMLINK" : st.isDirectory() ? "REAL_DIR" : "NOT_A_DIR";
console.log(
	`PROV head=${git(["rev-parse", "HEAD"])} write_tree=${git(["write-tree"])} head_tree=${git(["rev-parse", "HEAD^{tree}"])} ` +
		`porcelain=${JSON.stringify(git(["status", "--porcelain"]))} node_modules=${nmKind} ` +
		`entries=${st?.isDirectory() ? fs.readdirSync(nm).length : 0} worktree=${isWorktree}`,
);
if (problems.length) {
	console.error("certify-worktree-deps: FAIL\n  " + problems.join("\n  "));
	process.exit(1);
}
console.log("certify-worktree-deps: OK — this tree's @oh-my-pi/* imports resolve inside it");
