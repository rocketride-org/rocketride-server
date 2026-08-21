// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * App source packing — `rocketride/app-pack` (Node.js only).
 *
 * The CANONICAL implementation of the deploy pack rules: which files an app
 * deploy zip carries and how the zip is laid out. `deploy.addApp()` loads
 * this module at runtime, and the VS Code extension imports the same walker
 * for its own deploy flow — the rules live here and nowhere else.
 *
 * The zip carries the app's SOURCE (the server owns the build and never
 * trusts client-produced binaries), laid out WORKSPACE-RELATIVE: the app
 * folder packs at its real position (deploy metadata names it `appRoot`),
 * and `appManifest.include` entries — workspace-relative files or dirs the
 * build needs beyond the app folder — pack at theirs. Because the zip
 * mirrors the workspace tree, relative references between packed roots
 * resolve after the server unpacks, with nothing rewritten.
 *
 * Filtering follows git: a hardcoded baseline (node_modules/, dist/, .git/
 * — enforced even when no .gitignore exists, never re-includable by a
 * negation) plus the workspace's `.gitignore` files applied hierarchically —
 * every ancestor of a pack root contributes its rules, and each directory
 * entered during the walk contributes its own. Nested rules take git
 * precedence: the DEEPEST directory's decision wins. Ignored directories
 * are never descended into.
 *
 * Deliberate exceptions:
 * - `*.rrapp` markers always pack — deploy provenance, not user content.
 * - A pack root the user NAMED wins over rules that would exclude it.
 *
 * This module statically imports Node built-ins and adm-zip/ignore — it is
 * exported ONLY on the `rocketride/app-pack` subpath so browser bundles of
 * the main client never see it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { registerAppPack } from '../client/app-pack-registry.js';
import type { AppPackModule } from '../client/app-pack-registry.js';
import { renderTemplate, TEMPLATE_NAMES } from '../app-scaffold/index.js';
import type { TemplateName } from '../app-scaffold/index.js';

/** Receives one human-readable line per pack/verify step. */
export type PackProgress = (line: string) => void;

// =============================================================================
// LIMITS
// =============================================================================

/**
 * Ceiling on the UNCOMPRESSED source the deploy zip may carry — the archive
 * is built in memory, so an unbounded tree exhausts the host. A deploy packs
 * source only; a few hundred MB is far beyond any legitimate app plus its
 * declared includes.
 */
export const MAX_PACK_BYTES = 512 * 1024 * 1024;

/**
 * The upload cap on the ZIPPED package. The server refuses anything larger
 * at receipt before parsing a byte, so packing fails fast client-side with
 * the same bound and a pointer at the usual cause (an over-broad include).
 */
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;

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

/** The result of {@link packAppSource}. */
export interface PackedApp {
	/** The zip bytes to pass as `deploy.add({ kind: 'app', data })`. */
	data: Uint8Array;
	/** Workspace-relative POSIX path of the app folder (`metadata.appRoot`). */
	appRoot: string;
	/** Number of files packed. */
	fileCount: number;
	/** Total uncompressed bytes packed. */
	uncompressedBytes: number;
	/** Size of the zip itself. */
	zippedBytes: number;
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
 * SECURITY: this is the symlink-containment test. A symlink whose real
 * target escapes the workspace is a data-exfiltration path (vendor ->
 * ~/.aws packs credentials), so callers resolve the real destination and
 * reject anything outside the workspace root.
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

	// step: a directory this process cannot list (EACCES, or removed
	// mid-walk) is skipped rather than aborting the pack — the Python
	// mirror's os.scandir does the same
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(absDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
		const abs = path.join(absDir, entry.name);

		// step: classify, following symlinks (a junctioned shared dir is
		// legitimate); a broken link is silently skipped
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			// step: containment (SECURITY) — resolve the real destination and
			// skip anything outside the workspace root. Separate from the
			// `visited` guard, which only breaks cycles.
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
// FILE SELECTION
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
			// reached under two different zip paths. Cross-root dedup is by zip
			// path via `out`, not by real path — so each top-level root gets a
			// fresh visited set.
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

// =============================================================================
// INCLUDE VALIDATION
// =============================================================================

/**
 * Reads and validates the app's `appManifest.include` list.
 *
 * Entries are WORKSPACE-RELATIVE POSIX paths (files or directories),
 * packed verbatim at those paths — no resolution against the app folder,
 * no `..` walking: the zip packs exactly what the user wrote. Every
 * entry must exist; a typo fails the deploy loudly rather than shipping
 * a zip the server build cannot compile.
 *
 * @param appFolder - The app's folder (absolute path).
 * @param workspaceRoot - The workspace folder the zip is rooted at.
 * @param onProgress - Optional per-entry narration.
 * @returns Normalized include entries ([] when none are declared).
 * @throws Error on a malformed or missing entry.
 */
export function readIncludeEntries(appFolder: string, workspaceRoot: string, onProgress?: PackProgress): string[] {
	// step: read the CURRENT package.json — the include list must reflect
	// what is on disk at pack time, not a cached scan
	let pkg: { appManifest?: { include?: unknown } };
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(appFolder, 'package.json'), 'utf8'));
	} catch (err) {
		throw new Error(`Could not read the app's package.json: ${err instanceof Error ? err.message : String(err)}`);
	}
	const raw = pkg.appManifest?.include;
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string')) {
		throw new Error('appManifest.include must be an array of workspace-relative path strings.');
	}

	const entries: string[] = [];
	for (const item of raw as string[]) {
		// step: normalize separators, strip a trailing slash
		const entry = item.replace(/\\/g, '/').replace(/\/+$/, '');
		if (!entry) {
			throw new Error('appManifest.include contains an empty entry.');
		}
		// step: workspace-relative means RELATIVE — no absolute paths, no
		// drive letters, and no `..` escapes
		if (entry.startsWith('/') || entry.includes(':') || entry.split('/').includes('..') || entry.split('/').includes('.')) {
			throw new Error(`appManifest.include entry "${item}" must be a plain workspace-relative path (no absolute paths, drive letters, "." or "..").`);
		}
		const abs = path.join(workspaceRoot, entry);
		if (!fs.existsSync(abs)) {
			onProgress?.(`check include "${entry}" — FAILED: does not exist in the workspace`);
			throw new Error(`appManifest.include entry "${entry}" does not exist in the workspace.`);
		}
		onProgress?.(`check include "${entry}" — OK (${fs.statSync(abs).isDirectory() ? 'directory' : 'file'})`);
		entries.push(entry);
	}
	return entries;
}

// =============================================================================
// PACK
// =============================================================================

/**
 * Packs an app's source into the deploy zip, exactly as the App Builder
 * does: workspace-rooted layout, `appManifest.include` honored, gitignore
 * + baseline filtering, both size caps enforced.
 *
 * @param workspaceRoot - Absolute path of the workspace the zip is rooted
 *   at (the directory `include` entries are relative to).
 * @param appRoot - The app folder: absolute, or relative to workspaceRoot.
 *   Must be inside the workspace.
 * @param onProgress - Optional per-step narration (include checks, per-file
 *   adds, totals) for hosts that surface pack progress.
 * @returns The zip bytes plus the metadata and a pack report.
 * @throws Error on a missing folder, an invalid include entry, or a
 *   breached size cap.
 */
export function packAppSource(workspaceRoot: string, appRoot: string, onProgress?: PackProgress): PackedApp {
	const { wsAbs, appAbs, appRootRel } = resolveAppRoot(workspaceRoot, appRoot);

	// step: select the files — the app folder plus its declared includes
	const includes = readIncludeEntries(appAbs, wsAbs, onProgress);
	const files = collectPackedFiles(wsAbs, [appRootRel, ...includes]);
	if (files.length === 0) {
		throw new Error(`Nothing to pack under "${appRootRel}" — is the folder empty or fully ignored?`);
	}
	onProgress?.(`packing ${files.length} files (appRoot=${appRootRel || '.'}${includes.length ? `, include=${includes.join(',')}` : ''})`);

	// step: build the zip in memory, enforcing the uncompressed cap as we go
	const zip = new AdmZip();
	let uncompressedBytes = 0;
	for (const file of files) {
		const bytes = fs.readFileSync(file.absPath);
		uncompressedBytes += bytes.byteLength;
		if (uncompressedBytes > MAX_PACK_BYTES) {
			onProgress?.(`pack ABORTED — source exceeds ${Math.floor(MAX_PACK_BYTES / (1024 * 1024))} MB`);
			throw new Error(`Pack exceeds ${Math.floor(MAX_PACK_BYTES / (1024 * 1024))}MB uncompressed — narrow appManifest.include or add ignores.`);
		}
		zip.addFile(file.zipPath, bytes);
		onProgress?.(`+ ${file.zipPath} (${bytes.byteLength} bytes)`);
	}
	const buffer = zip.toBuffer();
	if (buffer.byteLength > MAX_ZIP_BYTES) {
		onProgress?.(`pack ABORTED — ${Math.round(buffer.byteLength / (1024 * 1024))} MB zipped exceeds the ${Math.floor(MAX_ZIP_BYTES / (1024 * 1024))} MB upload cap`);
		throw new Error(`Zip exceeds ${Math.floor(MAX_ZIP_BYTES / (1024 * 1024))}MB — the server refuses larger uploads; narrow appManifest.include or add ignores.`);
	}
	onProgress?.(`pack complete — ${files.length} files, ${uncompressedBytes} bytes source, ${buffer.byteLength} bytes zipped`);

	return {
		data: new Uint8Array(buffer),
		appRoot: appRootRel,
		fileCount: files.length,
		uncompressedBytes,
		zippedBytes: buffer.byteLength,
	};
}

// =============================================================================
// VERIFY
// =============================================================================

/** One verification check's outcome. */
export interface AppVerifyCheck {
	/** Stable check id (e.g. 'manifest', 'id', 'include', 'pack-size'). */
	id: string;
	/** Whether the check passed. */
	ok: boolean;
	/** Human-readable outcome, actionable on failure. */
	note: string;
}

/** The result of {@link verifyAppSource}. */
export interface AppVerifyReport {
	/** True when every check passed. */
	ok: boolean;
	/** Every check that ran, in order. */
	checks: AppVerifyCheck[];
	/** Files the pack would carry (0 when selection failed). */
	fileCount: number;
	/** Uncompressed bytes the pack would carry. */
	uncompressedBytes: number;
}

/** App id grammar: `<developerId>.<name>` (mirrors the App Builder). */
const APP_ID_RE = /^[a-z][a-z_]*\.[a-z][a-zA-Z0-9_-]*$/;

/**
 * Pre-checks everything an app deploy needs, WITHOUT deploying — the
 * standalone dry run behind `deploy.verifyApp()`. Purely local: manifest
 * shape, id grammar, declared assets, include entries, and a pack dry run
 * against the size caps. Server-side concerns (the build, store review)
 * are not checked here.
 *
 * @param workspaceRoot - Absolute path of the workspace the zip would be
 *   rooted at.
 * @param appRoot - The app folder: absolute, or relative to workspaceRoot.
 * @returns The structured report; never throws for check failures (only
 *   for a workspace/app path that cannot be resolved at all).
 */
export function verifyAppSource(workspaceRoot: string, appRoot: string): AppVerifyReport {
	const checks: AppVerifyCheck[] = [];
	const add = (id: string, ok: boolean, note: string): void => {
		checks.push({ id, ok, note });
	};
	const { wsAbs, appAbs, appRootRel } = resolveAppRoot(workspaceRoot, appRoot);

	// step: manifest readable + shaped
	let manifest: Record<string, unknown> | undefined;
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(appAbs, 'package.json'), 'utf8')) as { appManifest?: Record<string, unknown> };
		manifest = pkg.appManifest;
		add('package-json', true, 'package.json parses');
	} catch (err) {
		add('package-json', false, `package.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (manifest === undefined) {
		add('manifest', false, 'package.json has no appManifest block');
	} else {
		add('manifest', true, 'appManifest present');

		// step: identity — id grammar and name
		const id = typeof manifest.id === 'string' ? manifest.id : '';
		if (!id) {
			add('id', false, 'appManifest.id is missing');
		} else if (!APP_ID_RE.test(id)) {
			add('id', false, `appManifest.id "${id}" is not <developerId>.<name> (lowercase; name may add digits/-/_)`);
		} else {
			add('id', true, id.startsWith('local.') ? `id "${id}" is in the local namespace — register a developer id before publishing beyond this workspace` : `id "${id}" is well-formed`);
		}
		const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
		add('name', name.length > 0, name ? `display name "${name}"` : 'appManifest.name is missing or empty');

		// step: declared assets must exist (app-folder-relative paths)
		for (const key of ['icon', 'readme'] as const) {
			const declared = typeof manifest[key] === 'string' ? (manifest[key] as string) : '';
			if (!declared) {
				add(key, true, `no ${key} declared (optional; the store listing benefits from one)`);
			} else {
				const exists = fs.existsSync(path.join(appAbs, declared.replace(/^\.\//, '')));
				add(key, exists, exists ? `${key} "${declared}" exists` : `${key} "${declared}" does not exist in the app folder`);
			}
		}
	}

	// step: include entries + the layout rule
	let includes: string[] = [];
	try {
		includes = readIncludeEntries(appAbs, wsAbs);
		add('include', true, includes.length ? `${includes.length} include entr${includes.length === 1 ? 'y' : 'ies'} valid` : 'no include entries');
	} catch (err) {
		add('include', false, err instanceof Error ? err.message : String(err));
	}
	if (appRootRel === '' && includes.length > 0) {
		add('include-layout', false, 'appManifest.include needs the app inside a larger workspace — the workspace folder IS the app folder here');
	}

	// step: pack dry run — selection + uncompressed size vs the caps (the
	// zipped cap is only measurable at real pack time)
	let fileCount = 0;
	let uncompressedBytes = 0;
	try {
		const files = collectPackedFiles(wsAbs, [appRootRel, ...includes]);
		fileCount = files.length;
		for (const file of files) {
			uncompressedBytes += fs.statSync(file.absPath).size;
		}
		if (fileCount === 0) {
			add('pack', false, `nothing to pack under "${appRootRel || '.'}" — empty or fully ignored`);
		} else if (uncompressedBytes > MAX_PACK_BYTES) {
			add('pack', false, `source is ${Math.round(uncompressedBytes / (1024 * 1024))} MB uncompressed — over the ${Math.floor(MAX_PACK_BYTES / (1024 * 1024))} MB cap; narrow appManifest.include or add ignores`);
		} else {
			add('pack', true, `${fileCount} files, ${uncompressedBytes} bytes uncompressed (zip cap ${Math.floor(MAX_ZIP_BYTES / (1024 * 1024))} MB checked at pack time)`);
		}
	} catch (err) {
		add('pack', false, err instanceof Error ? err.message : String(err));
	}

	return { ok: checks.every((c) => c.ok), checks, fileCount, uncompressedBytes };
}

// =============================================================================
// CREATE (scaffold a new app)
// =============================================================================

/** Options for {@link createAppWorkspace}. */
export interface CreateAppOptions {
	/** Template to render (default 'Blank'). */
	template?: TemplateName;
	/** Display name (default: the slug, title-cased). */
	displayName?: string;
	/** Developer id for `<developerId>.<slug>` (default 'local' — publishable
	    beyond the workspace only after a real developer id is registered). */
	developerId?: string;
	/** Frame options — chrome regions of the generated app. */
	sidebar?: boolean;
	statusFooter?: boolean;
	docTabs?: boolean;
	/** HTTP(S) base of the development server, used to vendor the
	    server-matched shell + client packages. Omitted/unreachable = the
	    scaffold still succeeds and the pins link on the next connected open. */
	serverBaseUrl?: string;
	/** Run `pnpm install` at the workspace root (default true). */
	install?: boolean;
	/** Per-step narration. */
	onProgress?: PackProgress;
}

/** The result of {@link createAppWorkspace}. */
export interface CreatedApp {
	/** The full app id (`<developerId>.<slug>`). */
	appId: string;
	/** Workspace-relative POSIX path of the created folder. */
	folder: string;
	/** Project-relative paths of the files written. */
	files: string[];
	/** Which server-matched packages were vendored this pass. */
	vendored: { shell: boolean; client: boolean };
	/** Whether the workspace `pnpm install` ran and succeeded. */
	installed: boolean;
}

/** Slug grammar: the name part of the app id. */
const SLUG_RE = /^[a-z][a-zA-Z0-9_-]*$/;
/** Developer-id grammar: the namespace part of the app id. */
const DEVELOPER_RE = /^[a-z][a-z_]*$/;

/**
 * Scaffolds a new app — the programmatic twin of the App Builder's New App
 * wizard, rendering the exact same templates. Writes the app under
 * `./apps/<slug>`, ensures the pnpm workspace file and ignore hygiene,
 * vendors the server-matched platform packages when a server is reachable,
 * and installs. Everything after the scaffold (editing, verify, deploy)
 * is the normal app lifecycle.
 *
 * @param workspaceRoot - The workspace folder that owns ./apps.
 * @param slug - The app-name slug (lowercase; digits/-/_ after the first).
 * @param options - See {@link CreateAppOptions}.
 * @returns The created app's identity and a report of what ran.
 * @throws Error on an invalid slug/developer id or an existing folder.
 */
export async function createAppWorkspace(workspaceRoot: string, slug: string, options: CreateAppOptions = {}): Promise<CreatedApp> {
	const progress = options.onProgress ?? ((): void => undefined);
	const wsAbs = path.resolve(workspaceRoot);

	// step: identity — validate both id halves before touching disk
	if (!SLUG_RE.test(slug)) {
		throw new Error(`App slug "${slug}" is invalid — lowercase letter first, then letters/digits/-/_.`);
	}
	const developerId = options.developerId ?? 'local';
	if (!DEVELOPER_RE.test(developerId)) {
		throw new Error(`Developer id "${developerId}" is invalid — lowercase letters/underscores only.`);
	}
	const appId = `${developerId}.${slug}`;
	const template = options.template ?? 'Blank';
	if (!TEMPLATE_NAMES.includes(template)) {
		throw new Error(`Unknown template "${template}" — available: ${TEMPLATE_NAMES.join(', ')}.`);
	}

	// step: destination — ./apps/<slug>, never over an existing folder
	const folderRel = `apps/${slug}`;
	const folderAbs = path.join(wsAbs, 'apps', slug);
	if (fs.existsSync(folderAbs)) {
		throw new Error(`"${folderRel}" already exists — pick another slug or remove the folder.`);
	}

	// step: render the canonical templates (identical to the wizard's)
	const displayName = options.displayName ?? slug.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
	// Deterministic dev port per slug so repeated scaffolds of one app keep
	// their launch config stable without colliding across apps.
	let hash = 0;
	for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	const port = 3700 + (hash % 300);
	const base = options.serverBaseUrl?.replace(/\/+$/, '') || 'http://localhost:5565';
	const files = renderTemplate(template, {
		appId,
		appName: displayName,
		publisher: developerId,
		moduleId: appId.replace(/[.-]/g, '_'),
		port,
		previewUrl: `${base}/?appid=${appId}&rrdev=1`,
	}, {
		sidebar: options.sidebar ?? false,
		statusFooter: options.statusFooter ?? true,
		docTabs: options.docTabs ?? false,
	});
	for (const file of files) {
		const abs = path.join(folderAbs, ...file.path.split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, file.content);
		progress(`+ ${folderRel}/${file.path}`);
	}

	// step: workspace hygiene — the pnpm workspace file that links every
	// app, and the ignore entries that keep credentials and outputs out
	// of git. Existing files are respected: the workspace yaml is only
	// CREATED when missing (never rewritten), ignores only appended.
	const wsYaml = path.join(wsAbs, 'pnpm-workspace.yaml');
	if (!fs.existsSync(wsYaml)) {
		fs.writeFileSync(wsYaml, "packages:\n  - 'apps/*'\n");
		progress('+ pnpm-workspace.yaml (claims apps/*)');
	} else if (!/apps\/\*/.test(fs.readFileSync(wsYaml, 'utf8'))) {
		progress("warning: pnpm-workspace.yaml does not claim 'apps/*' — add it so the workspace install links this app");
	}
	const gitignorePath = path.join(wsAbs, '.gitignore');
	const wanted = ['.rocketride/', '.env', '**/node_modules/', '**/dist/'];
	const existingIgnore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
	const missing = wanted.filter((entry) => !existingIgnore.split(/\r?\n/).some((line) => line.trim() === entry));
	if (missing.length > 0) {
		fs.writeFileSync(gitignorePath, `${existingIgnore ? `${existingIgnore.replace(/\n*$/, '\n')}` : ''}${missing.join('\n')}\n`);
		progress(`+ .gitignore (${missing.join(', ')})`);
	}

	// step: vendor the server-matched platform packages (stable names the
	// scaffolded file: specs point at). Failures are non-fatal by the same
	// doctrine as the App Builder: the specs are the well-known locations
	// and link on the next connected open.
	const vendored = { shell: false, client: false };
	if (options.serverBaseUrl) {
		const vendorOne = async (route: string, dir: string, fileName: string, label: string): Promise<boolean> => {
			try {
				const res = await fetch(new URL(route, `${base}/`), { signal: AbortSignal.timeout(30_000) });
				if (!res.ok) {
					progress(`vendoring ${label} skipped — ${base}/${route} returned HTTP ${res.status}`);
					return false;
				}
				const tgz = Buffer.from(await res.arrayBuffer());
				const target = path.join(wsAbs, '.rocketride', dir, fileName);
				if (fs.existsSync(target) && tgz.equals(fs.readFileSync(target))) {
					progress(`${label} unchanged`);
					return true;
				}
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, tgz);
				progress(`vendored ${label} (${(tgz.length / 1024).toFixed(0)} KB)`);
				return true;
			} catch (err) {
				progress(`vendoring ${label} skipped — ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		};
		vendored.shell = await vendorOne('client/shell', 'shell', 'shell.tgz', 'shell package');
		vendored.client = await vendorOne('client/typescript', 'client', 'rocketride.tgz', 'client SDK package');
	} else {
		progress('no server base URL — platform packages will vendor on the next connected open');
	}

	// step: link everything (pnpm is the REQUIRED toolchain — npm is never
	// correct in an app workspace). Failure is non-fatal: the files are
	// valid and a later install links them.
	let installed = false;
	if (options.install !== false) {
		progress('pnpm install --prefer-offline');
		installed = await new Promise<boolean>((resolve) => {
			// Single command string when a shell is involved: passing an args
			// array with shell:true concatenates unescaped (Node DEP0190).
			// stdio:'ignore' because nobody reads these pipes — a full pipe
			// buffer would block pnpm forever and the timer below would kill
			// an install that was in fact succeeding.
			const proc = process.platform === 'win32'
				? spawn('pnpm install --prefer-offline', { cwd: wsAbs, shell: true, stdio: 'ignore', env: { ...process.env, NO_COLOR: '1' } })
				: spawn('pnpm', ['install', '--prefer-offline'], { cwd: wsAbs, stdio: 'ignore', env: { ...process.env, NO_COLOR: '1' } });
			const timer = setTimeout(() => {
				proc.kill();
				resolve(false);
			}, 300_000);
			proc.on('error', () => {
				clearTimeout(timer);
				progress('pnpm not found — install pnpm (npm install -g pnpm) and run pnpm install at the workspace root');
				resolve(false);
			});
			proc.on('close', (code) => {
				clearTimeout(timer);
				if (code !== 0) progress(`pnpm install exited ${code} — run it manually at the workspace root`);
				resolve(code === 0);
			});
		});
	}

	progress(`created ${appId} at ${folderRel} (${files.length} files)`);
	return { appId, folder: folderRel, files: files.map((f) => `${folderRel}/${f.path}`), vendored, installed };
}

// =============================================================================
// SHARED RESOLUTION + REGISTRATION
// =============================================================================

/**
 * Resolves and validates the workspace/app-root pair shared by pack and
 * verify: the app folder must exist, be a directory, and live inside the
 * workspace (the zip layout is workspace-relative).
 */
function resolveAppRoot(workspaceRoot: string, appRoot: string): { wsAbs: string; appAbs: string; appRootRel: string } {
	const wsAbs = path.resolve(workspaceRoot);
	const appAbs = path.isAbsolute(appRoot) ? path.resolve(appRoot) : path.resolve(wsAbs, appRoot);
	if (!fs.existsSync(appAbs) || !fs.statSync(appAbs).isDirectory()) {
		throw new Error(`App folder "${appRoot}" does not exist or is not a directory.`);
	}
	const relNative = path.relative(wsAbs, appAbs);
	if (relNative.startsWith('..') || path.isAbsolute(relNative)) {
		throw new Error(`App folder "${appRoot}" is outside the workspace root "${workspaceRoot}".`);
	}
	const appRootRel = relNative === '' ? '' : relNative.split(path.sep).join('/');
	return { wsAbs, appAbs, appRootRel };
}

// Arm the client's registry so bundled hosts (which cannot dynamically
// resolve package specifiers at runtime) get the packer through their own
// static import of this module.
registerAppPack({ MAX_PACK_BYTES, MAX_ZIP_BYTES, collectPackedFiles, readIncludeEntries, packAppSource, verifyAppSource, createAppWorkspace } as AppPackModule);
