// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pack filter — selects the files a deploy zip carries.
 *
 * Walks a set of WORKSPACE-RELATIVE pack roots (the app folder plus any
 * `appManifest.include` entries) and yields every file that survives the
 * ignore rules, each addressed by the workspace-relative path it keeps
 * inside the zip. The zip mirrors the workspace tree, so relative
 * references between packed roots (an app's `../shared/src/*` tsconfig
 * mapping, a `file:` dependency) resolve after the server unpacks —
 * nothing is ever rewritten.
 *
 * Filtering follows git: a hardcoded baseline (node_modules/, dist/,
 * .git/ — enforced even when no .gitignore exists, and never re-includable
 * by a negation) plus the workspace's `.gitignore` files applied
 * hierarchically — every ancestor of a pack root contributes its rules,
 * and each directory entered during the walk contributes its own. Nested
 * rules take git precedence: the DEEPEST directory's decision wins, so a
 * nested `!keep.log` re-includes a file an ancestor's `*.log` excluded.
 * Ignored directories are never descended into, which is also what keeps
 * cross-file semantics aligned with git's (a nested negation cannot revive
 * a file whose parent directory is excluded — git's own limitation).
 *
 * Deliberate exceptions:
 * - `*.rrapp` markers always pack — deploy provenance the receipt reads,
 *   not user content.
 * - A pack root the user NAMED wins over rules that would exclude it:
 *   any rule set that ignores the root itself is dropped for that root's
 *   walk (an explicit include is intent), while every other rule keeps
 *   filtering its contents.
 *
 * No vscode imports — pure fs/path so the walker is unit-testable and
 * portable to the browser packer's fs abstraction later.
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';

// =============================================================================
// TYPES
// =============================================================================

/** One file selected for the zip. */
export interface PackedFile {
	/** Workspace-relative POSIX path — the entry name inside the zip. */
	zipPath: string;
	/** Absolute path on disk to read the bytes from. */
	absPath: string;
}

/** An ignore matcher scoped to the directory whose rules it carries. */
interface ScopedMatcher {
	/** Workspace-relative POSIX dir the rules are anchored at ('' = root). */
	baseRel: string;
	/** The compiled matcher for that directory's patterns. */
	matcher: Ignore;
	/** Always-on baseline exclude (node_modules/, dist/, .git/): a hard
	    floor no `.gitignore` negation can re-include. Absent on real
	    `.gitignore` matchers, which follow git's deepest-wins precedence. */
	hard?: boolean;
}

// =============================================================================
// BASELINE
// =============================================================================

/**
 * Always-on excludes, in gitignore syntax, anchored at the workspace root.
 * Slash-less dir patterns match at every depth (git semantics), so one
 * baseline matcher covers the whole tree even when no .gitignore exists.
 * `.git/` is here because a real .gitignore never lists it.
 */
const BASELINE_PATTERNS = ['node_modules/', 'dist/', '.git/'];

// =============================================================================
// MATCHING
// =============================================================================

/**
 * Loads a directory's .gitignore into a scoped matcher, or null when the
 * directory has none (or it is unreadable — treated as absent, like git).
 *
 * @param absDir - Absolute directory to probe.
 * @param baseRel - The directory's workspace-relative POSIX path.
 * @returns The scoped matcher, or null.
 */
function gitignoreMatcherOf(absDir: string, baseRel: string): ScopedMatcher | null {
	try {
		const raw = fs.readFileSync(path.join(absDir, '.gitignore'), 'utf8');
		return { baseRel, matcher: ignore().add(raw) };
	} catch {
		return null;
	}
}

/**
 * Tests a path against every matcher whose base contains it, following
 * git's precedence. Directories are tested with a trailing slash so
 * dir-only patterns (`dist/`) match.
 *
 * Precedence, matching git:
 *  1. The always-on baseline excludes are a hard floor — node_modules/,
 *     dist/, .git/ are never re-includable by a `.gitignore` negation.
 *  2. The `.gitignore` matchers resolve DEEPEST-WINS: the closest
 *     directory's decision (ignore or an explicit `!` re-include) wins over
 *     any ancestor's. Only a matcher that renders no verdict on the path
 *     defers outward. `matchers` is outermost-first, so the deepest-wins
 *     pass iterates it in reverse.
 *
 * @param rel - Workspace-relative POSIX path of the entry.
 * @param isDir - Whether the entry is a directory.
 * @param matchers - Active scoped matchers, outermost first.
 * @returns true when the entry is ignored.
 */
function isIgnored(rel: string, isDir: boolean, matchers: ScopedMatcher[]): boolean {
	// step: scope a path into a matcher's base dir, or null when it is outside
	const scopeInto = (baseRel: string): string | null => {
		if (baseRel === '') return rel;
		if (rel.startsWith(`${baseRel}/`)) return rel.slice(baseRel.length + 1);
		return null;
	};

	// step: baseline floor first — an always-on exclude wins unconditionally
	for (const { baseRel, matcher, hard } of matchers) {
		if (!hard) continue;
		const scoped = scopeInto(baseRel);
		if (scoped === null) continue;
		if (matcher.ignores(isDir ? `${scoped}/` : scoped)) return true;
	}

	// step: .gitignore precedence — deepest directory wins; a nested `!rule`
	// re-includes a file an ancestor ignored. First VERDICT (ignore or
	// re-include) decides; a no-match matcher defers to its ancestor.
	for (let i = matchers.length - 1; i >= 0; i--) {
		const { baseRel, matcher, hard } = matchers[i];
		if (hard) continue;
		const scoped = scopeInto(baseRel);
		if (scoped === null) continue;
		const verdict = matcher.test(isDir ? `${scoped}/` : scoped);
		if (verdict.ignored) return true;
		if (verdict.unignored) return false;
	}
	return false;
}

// =============================================================================
// WALK
// =============================================================================

/**
 * Matchers for every .gitignore on the ancestor chain of a pack root:
 * the workspace root's, then each intermediate directory's down to (and
 * including) the root's parent. The pack root's own .gitignore is picked
 * up by the walk itself when it enters the directory.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param rootRel - Workspace-relative POSIX path of the pack root.
 * @returns Scoped matchers, outermost first.
 */
function ancestorMatchersOf(workspaceRoot: string, rootRel: string): ScopedMatcher[] {
	const matchers: ScopedMatcher[] = [];
	const root = gitignoreMatcherOf(workspaceRoot, '');
	if (root) matchers.push(root);
	// step: walk down the ancestor chain, one segment at a time
	const segments = rootRel === '' ? [] : rootRel.split('/');
	let baseRel = '';
	for (const segment of segments.slice(0, -1)) {
		baseRel = baseRel === '' ? segment : `${baseRel}/${segment}`;
		const found = gitignoreMatcherOf(path.join(workspaceRoot, baseRel), baseRel);
		if (found) matchers.push(found);
	}
	return matchers;
}

/**
 * True when `target` is the workspace root itself or a path contained by
 * it, comparing resolved absolute paths.
 *
 * SECURITY: this is the symlink-containment test. `path.relative` is
 * case-insensitive on Windows, so a real target that escapes the workspace
 * yields a `..`-leading (or absolute) relative path and is rejected.
 *
 * @param root - Absolute, realpath-canonicalized workspace root.
 * @param target - Absolute real path to test for containment.
 */
function isWithin(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Recursively collects the surviving files under one directory.
 *
 * @param absDir - Absolute directory being walked.
 * @param relDir - Its workspace-relative POSIX path ('' = workspace root).
 * @param containRoot - Absolute, realpath-canonicalized workspace root; a
 *   symlink whose real target escapes it is skipped (symlink containment).
 * @param matchers - Active scoped matchers (grows as the walk descends).
 * @param visited - Real paths of directories already walked (cycle guard).
 * @param out - Collected files, keyed by zipPath for cross-root dedup.
 */
function walkDir(absDir: string, relDir: string, containRoot: string, matchers: ScopedMatcher[], visited: Set<string>, out: Map<string, PackedFile>): void {
	// step: cycle guard — a symlink loop must not walk forever
	let real: string;
	try {
		real = fs.realpathSync(absDir);
	} catch {
		return;
	}
	if (visited.has(real)) return;
	visited.add(real);

	// step: this directory's own .gitignore joins the active rule set
	const own = gitignoreMatcherOf(absDir, relDir);
	const active = own ? [...matchers, own] : matchers;

	for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
		const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
		const abs = path.join(absDir, entry.name);

		// step: classify, following symlinks (a junctioned shared dir is
		// legitimate); a broken link is silently skipped
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			// step: containment (SECURITY) — a symlink whose real target
			// escapes the workspace is a data-exfiltration path (vendor ->
			// ~/.aws packs credentials), so resolve the real destination and
			// skip anything outside the workspace root. This is separate from
			// the `visited` guard, which only breaks cycles.
			let realTarget: string;
			try {
				realTarget = fs.realpathSync(abs);
			} catch {
				continue; // broken link — skip, as git does
			}
			if (!isWithin(containRoot, realTarget)) continue;
			try {
				const stat = fs.statSync(abs);
				isDir = stat.isDirectory();
				isFile = stat.isFile();
			} catch {
				continue;
			}
		}

		if (isDir) {
			if (isIgnored(rel, true, active)) continue;
			walkDir(abs, rel, containRoot, active, visited, out);
		} else if (isFile) {
			// step: .rrapp markers are deploy provenance — always packed
			if (!entry.name.endsWith('.rrapp') && isIgnored(rel, false, active)) continue;
			if (!out.has(rel)) out.set(rel, { zipPath: rel, absPath: abs });
		}
	}
}

// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Collects every file the deploy zip should carry.
 *
 * @param workspaceRoot - Absolute path of the workspace folder the zip is
 *   rooted at.
 * @param packRoots - Workspace-relative POSIX paths to pack (the app
 *   folder first, then any include entries). '' packs the workspace root
 *   itself (the degenerate app-is-the-workspace case). A root may be a
 *   file or a directory; overlapping roots dedupe by zip path.
 * @returns The selected files, sorted by zipPath for deterministic zips.
 * @throws Error when a pack root does not exist.
 */
export function collectPackedFiles(workspaceRoot: string, packRoots: string[]): PackedFile[] {
	const out = new Map<string, PackedFile>();
	const baseline: ScopedMatcher = { baseRel: '', matcher: ignore().add(BASELINE_PATTERNS), hard: true };

	// Canonicalize the workspace root once so symlink containment compares
	// real paths (a symlinked, junctioned, or differently-cased root still
	// matches its own descendants).
	let containRoot: string;
	try {
		containRoot = fs.realpathSync(workspaceRoot);
	} catch {
		containRoot = path.resolve(workspaceRoot);
	}

	for (const rootRel of packRoots) {
		const abs = rootRel === '' ? workspaceRoot : path.join(workspaceRoot, rootRel);

		// step: a named root must exist — a typo fails the pack loudly
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			throw new Error(`Pack path "${rootRel}" does not exist in the workspace.`);
		}

		if (stat.isDirectory()) {
			// step: the named root wins over rules that would exclude it —
			// drop any rule set that ignores the root itself; every other
			// set keeps filtering the root's contents
			const candidates = [baseline, ...ancestorMatchersOf(workspaceRoot, rootRel)];
			const active = rootRel === '' ? candidates : candidates.filter((m) => !isIgnored(rootRel, true, [m]));

			// step: re-anchor the hard baseline AT the named root. The filter
			// above drops the workspace-anchored baseline whenever it ignores
			// the root itself (so a user can deliberately name `dist`, or a
			// path under a `node_modules` directory). But that also removed the
			// hard floor for the root's ENTIRE SUBTREE — without re-anchoring, a
			// nested `node_modules`/`.git`/`dist` inside the named root would
			// pack. A baseline scoped to the root excludes those descendants
			// (paths are tested relative to the root) while never re-excluding
			// the root itself (`scopeInto` renders no verdict on the base dir).
			if (rootRel !== '' && !active.some((m) => m.hard)) {
				active.push({ baseRel: rootRel, matcher: ignore().add(BASELINE_PATTERNS), hard: true });
			}
			// PER-ROOT cycle guard: `visited` breaks symlink LOOPS within one
			// walk. Sharing it across roots would wrongly drop a real directory
			// reached under two different zip paths (e.g. `shared` packed both
			// through an in-workspace symlink from one root AND as its own
			// explicit root). Cross-root dedup is by zip path via `out`, not by
			// real path — so each top-level root gets a fresh visited set.
			const visited = new Set<string>();
			walkDir(abs, rootRel, containRoot, active, visited, out);
		} else if (stat.isFile()) {
			if (!out.has(rootRel)) out.set(rootRel, { zipPath: rootRel, absPath: abs });
		}
	}

	// Code-unit comparison (NOT localeCompare, which follows the host ICU
	// locale) so the entry order — and therefore the zip bytes of an
	// immutable registry version — is identical on every machine.
	return [...out.values()].sort((a, b) => (a.zipPath < b.zipPath ? -1 : a.zipPath > b.zipPath ? 1 : 0));
}
