// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Platform package vendoring — installs the SHIPPED shell surface for apps.
 *
 * Standalone app repos have no rocketride-server checkout: platform modules
 * (the 'shell' surface) arrive from the shell's MF share scope at runtime
 * and are consume-only at build time. The connected server serves its own
 * platform as an installable npm package at /client/shell; this module
 * downloads it, extracts it to `<workspace>/.rocketride/shell/`, and makes
 * sure each app's package.json depends on that directory
 * (`"shell": "file:..."`), so types/tokens/code all flow through ordinary
 * npm resolution.
 *
 * Called at scaffold (new apps) and on every App Builder open (refresh —
 * apps track the platform of the CONNECTED server). Nothing is ever written
 * inside an app folder: the tarball and the extracted package live only
 * under `<workspace>/.rocketride/`, and each app carries just the file:
 * dependency pointing at that shared location.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';

// Single-flight memo for the workspace's ONE shell package: the first
// caller performs the vendor pass; concurrent callers (several App
// Builder panels, a scaffold racing an open) share the same in-flight
// promise; after a successful pass every later call resolves
// immediately. An unavailable result (offline, no packaged copy) clears
// the memo so the next open retries instead of caching failure for the
// whole session.
let ensureShellPromise: Promise<string | null> | null = null;

/**
 * Ensures the workspace's shell package is vendored — ONCE.
 *
 * Every consumer that needs .rocketride/shell (panel open, scaffold, the
 * watch's install step) awaits this instead of vendoring itself, so the
 * package is downloaded/extracted a single time per session and nothing
 * can race the swap with an install.
 *
 * @param context - Extension context (locates the packaged fallback tgz).
 * @returns The vendored package directory, or null when unavailable.
 */
export function ensureShell(context: vscode.ExtensionContext): Promise<string | null> {
	if (ensureShellPromise) return ensureShellPromise;
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) return Promise.resolve(null);
	ensureShellPromise = vendorShellPackage(workspaceRoot, path.join(context.extensionPath, 'shell.tgz')).then((dir) => {
		// vendorShellPackage never throws (non-fatal by design); null means
		// "not available right now" — forget the attempt so a later open
		// tries again with a (possibly) reachable server.
		if (!dir) ensureShellPromise = null;
		return dir;
	});
	return ensureShellPromise;
}

/**
 * Ensures the platform package is installed for an app.
 *
 * Wires the app's package.json dependency onto the workspace's
 * .rocketride/shell/ directory, then ensures the workspace's shared
 * vendor pass has run (see ensureShell — one download/extract per
 * session, shared by all consumers). Types, tokens, and (for static
 * consumers) compiled code all arrive through ordinary npm resolution —
 * no vendored type folder, no tsconfig paths.
 *
 * The dependency is written FIRST and unconditionally: the file: spec is
 * the well-known workspace location, valid before the package has ever
 * been downloaded, so an offline scaffold still produces the correct
 * package.json and simply links on the next connected open.
 *
 * Non-fatal by design: an unreachable server, a missing package, or an
 * unwritable folder logs and returns — platform tooling is an editor
 * concern, never a reason to block the dev loop.
 *
 * @param context - Extension context (locates the packaged fallback tgz).
 * @param appFolder - The app's root folder.
 */
export async function vendorAppTypes(context: vscode.ExtensionContext, appFolder: string): Promise<void> {
	const logger = getLogger();
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) return;
	try {
		ensureShellDependency(appFolder, path.join(workspaceRoot, '.rocketride', 'shell'));
	} catch (err) {
		logger.output(`[appdev] wiring the shell package dependency failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
	const pkgDir = await ensureShell(context);
	if (!pkgDir) {
		logger.output('[appdev] no shell package available (server unreachable, no packaged copy) — dependency is wired; contents arrive on the next connected open');
	}
}

// =============================================================================
// SHELL PACKAGE (shell.tgz)
// =============================================================================

/**
 * Ensures the app's package.json depends on the workspace shell package.
 *
 * The dependency targets the DIRECTORY (`file:<rel>/.rocketride/shell`),
 * never the tarball: a file: tgz dependency gets an integrity hash in
 * lockfiles, so every server upgrade would churn every app's lockfile; a
 * directory dependency is linked (pnpm hard-links its contents) and the
 * spec never changes across versions. Existing correct specs are left
 * untouched so repeated App Builder opens never rewrite the file.
 *
 * The target directory need not exist yet — the spec is the platform's
 * well-known workspace location, and pnpm links it once it appears.
 *
 * @param appFolder - The app's root folder (owns the package.json).
 * @param pkgDir - Absolute path of the shell package directory.
 */
function ensureShellDependency(appFolder: string, pkgDir: string): void {
	const logger = getLogger();
	const pkgJsonPath = path.join(appFolder, 'package.json');
	if (!fs.existsSync(pkgJsonPath)) return;
	// step: compute the app-relative file: spec with posix separators
	const rel = path.relative(appFolder, pkgDir).split(path.sep).join('/');
	const spec = `file:${rel}`;
	// step: rewrite only when missing or different
	const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
	if (pkg.dependencies?.shell === spec) return;
	pkg.dependencies = { ...(pkg.dependencies ?? {}), shell: spec };
	fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
	logger.output(`[appdev] package.json: "shell": "${spec}" — run pnpm install in ${appFolder} to (re)link the platform package`);
}

/**
 * One parsed tar entry: repo-relative path, type flag, and file bytes.
 */
interface TarEntry {
	name: string;
	type: string;
	data: Buffer;
}

/**
 * Minimal ustar reader for the server-packed shell.tgz.
 *
 * pnpm pack emits plain ustar (name + prefix fields) with pax extended
 * headers ('x') only for over-long paths; both are handled. This exists so
 * the extension needs no tar dependency for one well-known archive shape.
 *
 * @param tarBuf - The gunzipped tar bytes.
 * @returns Parsed entries (files and directories only).
 */
function parseTar(tarBuf: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	// Path override supplied by an immediately-preceding pax header.
	let paxPath: string | null = null;
	let off = 0;
	while (off + 512 <= tarBuf.length) {
		const block = tarBuf.subarray(off, off + 512);
		// step: two consecutive zero blocks terminate the archive
		if (block.every((b) => b === 0)) break;
		// step: decode the ustar header fields we need
		const readStr = (start: number, len: number): string => block.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '');
		const name = readStr(0, 100);
		const size = parseInt(readStr(124, 12).trim() || '0', 8);
		const type = readStr(156, 1) || '0';
		const prefix = readStr(345, 155);
		const dataStart = off + 512;
		const data = tarBuf.subarray(dataStart, dataStart + size);
		// step: advance to the next 512-aligned header
		off = dataStart + Math.ceil(size / 512) * 512;
		// step: pax extended header — records a long path for the NEXT entry
		if (type === 'x' || type === 'g') {
			const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
			if (type === 'x' && m) paxPath = m[1];
			continue;
		}
		const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
		paxPath = null;
		entries.push({ name: full, type, data: Buffer.from(data) });
	}
	return entries;
}

/**
 * Downloads the connected server's shell.tgz into the workspace's
 * .rocketride/ directory and extracts it to .rocketride/shell/.
 *
 * The tgz is the installable shell package (compiled lib + frozen contract
 * types + token CSS). App package.json files depend on the EXTRACTED
 * DIRECTORY (`file:.rocketride/shell`), never the tarball — a file: tgz
 * dependency gets an integrity hash in lockfiles, so every server upgrade
 * would churn every app's lockfile; a directory dependency is linked.
 *
 * An unchanged package is left ALONE: when the downloaded tgz is
 * byte-identical to the one already vendored, no swap happens at all —
 * the toolchain (dev server, pnpm links) actively reads this directory,
 * and a gratuitous swap yanks files out from under it.
 *
 * When the content did change, the swap is single-attempt and yielding:
 * the old package is renamed aside as a backup first, so a failure can
 * restore it and the workspace never ends up with NO platform package
 * (apps' file: dependency makes pnpm install impossible without one).
 * There are deliberately NO rename retries — fighting a live, watched
 * directory for it stalls the toolchain and feeds watcher/reload storms;
 * when the directory is busy the update is simply skipped and the next
 * App Builder open tries again. Non-fatal by design, like all type
 * vendoring.
 *
 * @param workspaceRoot - The workspace folder that owns .rocketride/.
 * @param fallbackTgz - Extension-packaged shell.tgz for offline use.
 * @returns The extracted package directory, or null when unavailable.
 */
export async function vendorShellPackage(workspaceRoot: string, fallbackTgz?: string): Promise<string | null> {
	const logger = getLogger();
	const baseUrl = ConnectionManager.getInstance().getHttpUrl?.() || '';
	try {
		// step: fetch the stable-named tarball from the connected server
		// (the public /client/shell route, beside the SDK downloads),
		// falling back to the extension-packaged copy when offline
		let tgz: Buffer | null = null;
		let source = '';
		if (baseUrl) {
			const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
			const res = await fetch(new URL('client/shell', base));
			if (res.ok) {
				tgz = Buffer.from(await res.arrayBuffer());
				source = `${baseUrl}/client/shell`;
			} else {
				logger.output(`[appdev] shell package not served by this server (HTTP ${res.status}) — trying the packaged copy`);
			}
		}
		if (!tgz && fallbackTgz && fs.existsSync(fallbackTgz)) {
			tgz = fs.readFileSync(fallbackTgz);
			source = 'extension-packaged copy';
		}
		if (!tgz) return null;

		const rrDir = path.join(workspaceRoot, '.rocketride');
		const tgzPath = path.join(rrDir, 'shell.tgz');
		const dest = path.join(rrDir, 'shell');

		// step: unchanged package — do not touch the installed directory
		if (fs.existsSync(dest) && fs.existsSync(path.join(dest, 'package.json')) && fs.existsSync(tgzPath) && tgz.equals(fs.readFileSync(tgzPath))) {
			logger.output(`[appdev] shell package unchanged (${source}) — keeping ${dest}`);
			return dest;
		}

		// step: extract into a staging dir (tar paths are 'package/<rel>')
		fs.mkdirSync(rrDir, { recursive: true });
		const staging = path.join(rrDir, 'shell.extracting');
		fs.rmSync(staging, { recursive: true, force: true });
		for (const entry of parseTar(zlib.gunzipSync(tgz))) {
			const rel = entry.name.replace(/^package\//, '');
			if (!rel || rel.includes('..')) continue;
			const target = path.join(staging, rel);
			if (entry.type === '5') {
				fs.mkdirSync(target, { recursive: true });
			} else if (entry.type === '0') {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, entry.data);
			}
		}

		// step: single-attempt swap, old package held as backup. A locked
		// directory (dev server reading, pnpm importing) skips the update
		// rather than fighting for it — the old package keeps working and
		// the next open retries with the saved tgz still marked stale.
		const backup = path.join(rrDir, 'shell.backup');
		fs.rmSync(backup, { recursive: true, force: true });
		const hadDest = fs.existsSync(dest);
		if (hadDest) {
			try {
				fs.renameSync(dest, backup);
			} catch {
				fs.rmSync(staging, { recursive: true, force: true });
				logger.output(`[appdev] shell package update deferred — ${dest} is in use (dev server or install running); keeping the current package`);
				return dest;
			}
		}
		try {
			fs.renameSync(staging, dest);
		} catch (err) {
			// Put the old package back so the workspace is never left empty.
			if (hadDest) fs.renameSync(backup, dest);
			throw err;
		}
		fs.rmSync(backup, { recursive: true, force: true });
		// step: record the tarball ONLY after a successful swap — it is the
		// unchanged-check's witness that dest matches it, and it doubles as
		// the provenance/debugging copy. A deferred or failed swap leaves
		// the old record, so the next pass still sees the content as stale.
		fs.writeFileSync(tgzPath, tgz);
		const version = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version;
		logger.output(`[appdev] vendored shell package v${version} from ${source} into ${dest}`);
		return dest;
	} catch (err) {
		logger.output(`[appdev] shell package vendoring failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}
