// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Platform package vendoring — installs the SHIPPED shell surface for apps.
 *
 * The connected server serves its platform as an installable npm package at
 * /client/shell. This module downloads it to the canonical
 * `<workspace>/.rocketride/shell/shell.tgz`, wires each app's package.json
 * dependency onto that tarball, and runs `pnpm install` at the workspace
 * root so every app links the new package. Types, tokens, and (for static
 * consumers) compiled code all flow through ordinary npm resolution — a
 * tarball dependency is a first-class package whose own dependencies pnpm
 * actually installs.
 *
 * Called at scaffold (new apps) and on every App Builder open (refresh —
 * apps track the platform of the CONNECTED server). Nothing is ever written
 * inside an app folder: the tarball lives under `<workspace>/.rocketride/`,
 * and each app carries just the file: dependency pointing at it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';

/**
 * Result of a shell vendor pass — success carries the artifact path,
 * failure carries WHY. Consumers surface the reason to the user (the App
 * Builder renders it center-screen); "returned null, check the log" is
 * not an API.
 */
export type ShellVendorResult =
	| {
		ok: true;
		/** Absolute path of the vendored shell tarball. */
		tgzPath: string;
		/** True when THIS pass rewrote the app's dependency spec — callers
		 * must invalidate any memoised install so the new spec links. */
		rewired?: boolean;
	}
	| { ok: false; reason: string };

// Single-flight memo for the workspace's ONE shell package: the first
// caller performs the vendor pass; concurrent callers (several App
// Builder panels, a scaffold racing an open) share the same in-flight
// promise; after a successful pass every later call resolves
// immediately. A failed result (offline, no packaged copy) clears the
// memo so the next open retries instead of caching failure for the
// whole session.
let ensureShellPromise: Promise<ShellVendorResult> | null = null;

/**
 * The workspace-install AUTHORITY — the WatchManager's generation-chained
 * single-flight, registered at its construction.
 *
 * While registered, every install this module needs routes through it, so
 * two pnpm processes can never touch the shared node_modules at once:
 * the vendor pass spawning its OWN pnpm beside the watch/scaffold install
 * raced it on fresh workspaces, and concurrent pnpm runs on one root fail
 * with ERR_PNPM_EEXIST during symlinkAllModules (a half-linked virtual
 * store). An injected seam rather than an import: watchManager already
 * imports from this module, so importing it back would be a cycle.
 */
let workspaceInstallDelegate: (() => Promise<boolean>) | null = null;

/**
 * Registers the single-flight workspace-install authority.
 *
 * The delegate must run a FRESH install when invoked (the caller has just
 * changed the vendored tarball): bump the install generation, then chain
 * the run behind any in-flight install.
 *
 * @param run - Resolves true when the workspace install succeeded, or null
 *              to UNREGISTER (the registering manager was disposed — module
 *              state outlives it, and a vendor pass during deactivation
 *              would otherwise install through a dead manager).
 */
export function setWorkspaceInstallDelegate(run: (() => Promise<boolean>) | null): void {
	workspaceInstallDelegate = run;
}

/**
 * Ensures the workspace's shell package is vendored — ONCE.
 *
 * Every consumer that needs the shell tarball (panel open, scaffold, the
 * watch's install step) awaits this instead of vendoring itself, so the
 * package is downloaded and installed a single time per session.
 *
 * @param context - Extension context (locates the packaged fallback tgz).
 * @returns The vendor result — path on success, the reason on failure.
 */
export function ensureShell(context: vscode.ExtensionContext): Promise<ShellVendorResult> {
	if (ensureShellPromise) return ensureShellPromise;
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) return Promise.resolve({ ok: false, reason: 'No workspace folder is open — the platform package lives under the workspace root.' });
	ensureShellPromise = vendorShellPackage(workspaceRoot, path.join(context.extensionPath, 'shell.tgz'), path.join(context.extensionPath, 'rocketride-client.tgz')).then((result) => {
		// vendorShellPackage never throws (non-fatal by design); a failure
		// clears the memo so a later open retries with a (possibly)
		// reachable server instead of caching the failure for the session.
		if (!result.ok) ensureShellPromise = null;
		return result;
	});
	return ensureShellPromise;
}

/**
 * Re-vendors the platform packages against the CURRENT server — used on
 * (re)connect, where the session memo would otherwise keep serving the
 * packages of a previous server (or the offline fallbacks) for the rest
 * of the session.
 *
 * @param context - Extension context (locates the packaged fallbacks).
 * @returns The vendor result — path on success, the reason on failure.
 */
export function refreshVendoredPlatform(context: vscode.ExtensionContext): Promise<ShellVendorResult> {
	// Chain behind any in-flight pass instead of dropping the memo: a
	// reconnect burst (org switch, network blip) fires this repeatedly, and
	// two concurrent passes write the same canonical tarball paths — the
	// read/compare/write sequence is not atomic, so an overlap can leave a
	// half-written tgz for the workspace install to read.
	const prior: Promise<unknown> = ensureShellPromise ?? Promise.resolve();
	const refreshed = prior.catch(() => null).then(() => {
		ensureShellPromise = null;
		return ensureShell(context);
	});
	ensureShellPromise = refreshed;
	return refreshed;
}

/**
 * Ensures the platform package is installed for an app.
 *
 * Wires the app's package.json dependency onto the workspace's canonical
 * .rocketride/shell/shell.tgz, then ensures the workspace's shared vendor
 * pass has run (see ensureShell — one download + install per session,
 * shared by all consumers).
 *
 * The dependency is written FIRST and unconditionally: the file: spec is
 * the well-known workspace location, valid before the package has ever
 * been downloaded, so an offline scaffold still produces the correct
 * package.json and simply links on the next connected open.
 *
 * Non-fatal by design: an unreachable server, a missing package, or an
 * unwritable folder logs and returns a reasoned failure — platform
 * tooling never throws into the dev loop, but the caller gets the WHY to
 * put in front of the user.
 *
 * @param context - Extension context (locates the packaged fallback tgz).
 * @param appFolder - The app's root folder.
 * @returns The vendor result — path on success, the reason on failure.
 */
export async function vendorAppTypes(context: vscode.ExtensionContext, appFolder: string): Promise<ShellVendorResult> {
	const logger = getLogger();
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) return { ok: false, reason: 'No workspace folder is open — the platform package lives under the workspace root.' };
	// Wiring failures FAIL the pass: an app whose workspace file or shell
	// dependency could not be written will not link the platform package, so
	// pretending success would only defer the error to a confusing place.
	try {
		ensureWorkspaceFile(workspaceRoot);
	} catch (err) {
		const reason = `Could not prepare the workspace file: ${err instanceof Error ? err.message : String(err)}`;
		logger.output(`[appdev] ${reason}`);
		return { ok: false, reason };
	}
	let rewired = false;
	try {
		rewired = ensureShellDependency(appFolder, path.join(workspaceRoot, '.rocketride', 'shell', 'shell.tgz'));
		rewired = ensureClientDependency(appFolder, path.join(workspaceRoot, '.rocketride', 'client', 'rocketride.tgz')) || rewired;
	} catch (err) {
		const reason = `Could not wire the platform dependencies into ${appFolder}: ${err instanceof Error ? err.message : String(err)}`;
		logger.output(`[appdev] ${reason}`);
		return { ok: false, reason };
	}
	const result = await ensureShell(context);
	if (!result.ok) {
		logger.output(`[appdev] shell package unavailable: ${result.reason}`);
		return result;
	}
	// Success carries whether this pass rewired the dependency spec, so the
	// caller can invalidate a pre-rewire install memo.
	return { ...result, rewired };
}

// =============================================================================
// WORKSPACE FILE
// =============================================================================

/**
 * Ensures the workspace root is a pnpm workspace claiming apps/* — so one
 * root install links every app. Nothing more: apps carry their own
 * relative shell spec (file:../../.rocketride/shell/shell.tgz), which
 * resolves without any override.
 *
 * Conservative line-level editing (the extension deliberately carries no
 * YAML dependency): a missing file is written whole; a present file only
 * gains the apps/* entry when no spelling of it exists, logged loudly (it
 * is user-owned); a file that already covers it (the monorepo dogfood
 * case) is left byte-identical. Also removes per-app pnpm-workspace.yaml
 * boundary files from the island era — under the workspace model the
 * nearest-yaml rule would silently isolate those apps from the root
 * install.
 *
 * Assumes workspaceFolders[0]; apps in a second workspace root are not
 * covered (known limitation, shared with ensureShell).
 *
 * @param workspaceRoot - The workspace folder to ensure.
 */
function ensureWorkspaceFile(workspaceRoot: string): void {
	const logger = getLogger();
	const yamlPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');

	if (!fs.existsSync(yamlPath)) {
		// step: no workspace file — write the canonical minimal one
		fs.writeFileSync(yamlPath, [
			'# RocketRide app workspace — one root install links every app under apps/.',
			'packages:',
			"  - 'apps/*'",
			'',
		].join('\n'));
		logger.output(`[appdev] wrote ${yamlPath} (pnpm workspace claiming apps/*)`);
	} else {
		// step: amend the existing file only when the claim is missing
		let text = fs.readFileSync(yamlPath, 'utf8');
		if (!/^\s*-\s*['"]?apps\/\*/m.test(text)) {
			const packagesLine = /^packages:([^\n]*)$/m.exec(text);
			if (packagesLine) {
				// An inline value (`packages: ['x']` / a scalar) cannot take an
				// appended block entry — refuse loudly instead of corrupting
				// the user-owned file (a trailing comment does not count).
				if ((packagesLine[1] ?? '').replace(/#.*$/, '').trim().length > 0) {
					throw new Error(`${yamlPath} declares packages as an inline value — add 'apps/*' manually`);
				}
				// Block form: match the first existing entry's indentation so
				// the added line follows the user's formatting; two spaces
				// when the list is empty.
				const indent = /^packages:[^\n]*\n([ \t]*)-\s/m.exec(text)?.[1] ?? '  ';
				text = text.replace(/^packages:[^\n]*\n?/m, (m) => `${m.endsWith('\n') ? m : `${m}\n`}${indent}- 'apps/*'\n`);
			} else {
				text += `${text.endsWith('\n') ? '' : '\n'}packages:\n  - 'apps/*'\n`;
			}
			fs.writeFileSync(yamlPath, text);
			logger.output(`[appdev] amended ${yamlPath} — added the apps/* claim (user-owned file; review the change)`);
		}
	}

	// step: retire island-era per-app boundary files — the nearest-yaml rule
	// would cut those apps out of the root workspace install
	const appsDir = path.join(workspaceRoot, 'apps');
	if (fs.existsSync(appsDir)) {
		for (const name of fs.readdirSync(appsDir)) {
			const boundary = path.join(appsDir, name, 'pnpm-workspace.yaml');
			if (fs.existsSync(boundary)) {
				fs.rmSync(boundary, { force: true });
				logger.output(`[appdev] removed ${boundary} (island-era boundary file — the root workspace owns installs now)`);
			}
		}
	}
}

// =============================================================================
// SHELL PACKAGE (shell.tgz)
// =============================================================================

/**
 * Ensures the app's package.json depends on the workspace shell tarball.
 *
 * The dependency targets `file:<rel>/.rocketride/shell/shell.tgz` — a
 * tarball is a first-class package to pnpm: it extracts into the store and
 * installs the shell's own declared dependencies with real linkage.
 * Existing correct specs are left untouched so repeated App Builder opens
 * never rewrite the file.
 *
 * The target file need not exist yet — the spec is the platform's
 * well-known workspace location, and pnpm links it once it appears.
 *
 * @param appFolder - The app's root folder (owns the package.json).
 * @param pkgTgz - Absolute path of the shell package tarball.
 * @returns True when a new spec was written; false when already correct (or
 *          the app has no package.json).
 */
function ensureShellDependency(appFolder: string, pkgTgz: string): boolean {
	return ensureTgzDependency(appFolder, 'shell', pkgTgz);
}

/**
 * Ensures the app's package.json depends on the workspace's vendored
 * CLIENT tarball (`file:<rel>/.rocketride/client/rocketride.tgz`). The
 * npm registry's `rocketride` can lag the connected server badly (no app
 * surface at all), so apps pin the server-matched package the same way
 * they pin the shell.
 *
 * @param appFolder - The app's root folder (owns the package.json).
 * @param pkgTgz - Absolute path of the client package tarball.
 * @returns True when a new spec was written; false when already correct.
 */
function ensureClientDependency(appFolder: string, pkgTgz: string): boolean {
	return ensureTgzDependency(appFolder, 'rocketride', pkgTgz);
}

/**
 * Shared rewiring for tarball-pinned dependencies: writes
 * `dependencies[depName] = file:<app-relative posix path>` only when
 * missing or different, so repeated App Builder opens never rewrite the
 * file. The target need not exist yet — the spec is the platform's
 * well-known workspace location, and pnpm links it once it appears.
 */
function ensureTgzDependency(appFolder: string, depName: string, pkgTgz: string): boolean {
	const logger = getLogger();
	const pkgJsonPath = path.join(appFolder, 'package.json');
	if (!fs.existsSync(pkgJsonPath)) return false;
	// step: compute the app-relative file: spec with posix separators
	const rel = path.relative(appFolder, pkgTgz).split(path.sep).join('/');
	const spec = `file:${rel}`;
	// step: rewrite only when missing or different
	const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
	if (pkg.dependencies?.[depName] === spec) return false;
	pkg.dependencies = { ...(pkg.dependencies ?? {}), [depName]: spec };
	fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
	logger.output(`[appdev] package.json: "${depName}": "${spec}"`);
	return true;
}

/**
 * Runs `pnpm install` at the workspace root and resolves on success.
 *
 * The root-level install is what links the freshly vendored tarball into
 * every app: pnpm sees the changed file, extracts it into the store, and
 * rewires each member's node_modules.
 *
 * @param workspaceRoot - The workspace folder to install in.
 * @returns Resolves on exit 0; rejects with the tail of the output otherwise.
 */
function runRootInstall(workspaceRoot: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// step: spawn pnpm at the root; shell:true resolves pnpm.cmd on Windows
		const proc = spawn('pnpm', ['install', '--prefer-offline'], {
			cwd: workspaceRoot,
			shell: process.platform === 'win32',
			env: { ...process.env, NO_COLOR: '1' },
		});
		// step: collect output so a failure can NAME its cause
		let output = '';
		proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
		proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
		// step: settle EXACTLY once — an unsettled promise here wedges the
		// single-flight ensureShell memo for the whole session, and 'error'
		// followed by 'close' (or a timeout racing either) fires both paths
		let settled = false;
		const finish = (err?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve();
		};
		// step: bound the install — a hung pnpm (dead registry, lock wait)
		// must fail the pass instead of hanging it forever. shell:true wraps
		// pnpm in cmd.exe on Windows, so SIGKILL fells only the wrapper while
		// pnpm keeps running (and holding locks) — taskkill /T fells the whole
		// tree, same approach as watchManager.stop().
		const timer = setTimeout(() => {
			if (process.platform === 'win32' && proc.pid) {
				spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
			} else {
				proc.kill('SIGKILL');
			}
			finish(new Error('pnpm install timed out after 10 minutes'));
		}, 10 * 60 * 1000);
		proc.on('error', (err) => finish(err));
		proc.on('close', (code) => {
			if (code === 0) finish();
			else finish(new Error(`pnpm install failed: ${extractInstallCause(output, code)}`));
		});
	});
}

/**
 * Pulls the most informative line out of pnpm's output — the actual error
 * (ERR_PNPM_*, ENOENT, EACCES, ...) rather than the whole transcript — so
 * failure messages state the cause instead of pointing at a log.
 *
 * @param output - Combined stdout+stderr of the pnpm run.
 * @param code - The process exit code (fallback when no error line parses).
 * @returns One human-readable cause line.
 */
export function extractInstallCause(output: string, code: number | null): string {
	const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	// step: tiered markers, most specific first — a generic "error" line must
	// not outrank pnpm's own ERR_PNPM_* code; newest match within a tier wins
	const tiers = [/ERR_PNPM\w*/, /\b(ENOENT|EACCES|EPERM)\b/, /ERR!/, /\berror\b/i];
	for (const marker of tiers) {
		const marked = lines.filter((l) => marker.test(l));
		if (marked.length > 0) return marked[marked.length - 1];
	}
	// step: otherwise the last line of output beats a bare exit code
	return lines.length > 0 ? lines[lines.length - 1] : `exit code ${code}`;
}

/**
 * True when pnpm install output carries a TRANSIENT Windows file-lock
 * signature rather than a genuine dependency or build failure.
 *
 * On Windows another process routinely holds a short-lived handle on a file
 * under `node_modules/.pnpm` — antivirus scanning a just-written file, the
 * Search indexer, or an editor watching the tree — so pnpm's atomic
 * rename/unlink step fails with EPERM/EBUSY/ENOTEMPTY even though the
 * dependency graph is sound. The handle is released moments later and a fresh
 * install succeeds, so the caller may safely retry ONLY this class of error.
 * A resolution error, a missing package, or a build failure never matches and
 * so is never retried.
 *
 * @param output - Combined stdout+stderr of the failed pnpm run.
 * @returns True when the failure is a retriable transient lock.
 */
export function isTransientLockError(output: string): boolean {
	// Both halves must hold ON THE SAME LINE: the errno AND a filesystem op it
	// aborted. pnpm mentions "rename" in ordinary progress, so an EPERM sitting
	// on an unrelated line must not pair with it — a genuine transient lock
	// prints the errno and the aborted op together on one line.
	//
	// EEXIST pairs ONLY with symlink: pnpm's symlinkAllModules hits it when a
	// previous install died (or raced) mid-link and left the virtual store
	// half-written — a rerun reconciles the store and succeeds, so it earns a
	// retry; EEXIST anywhere else stays a genuine failure.
	const errno = /\b(EPERM|EBUSY|ENOTEMPTY|EEXIST)\b/;
	const fsOp = /(rename|unlink|symlink|operation not permitted|resource busy|directory not empty)/i;
	return output.split(/\r?\n/).some((line) => {
		if (!errno.test(line) || !fsOp.test(line)) return false;
		return !/\bEEXIST\b/.test(line) || /symlink/i.test(line);
	});
}

/** Largest vendored tarball the extension will accept from a server. */
const MAX_VENDORED_TGZ_BYTES = 64 * 1024 * 1024;

/**
 * Reads a fetch response body into a Buffer, refusing anything oversized.
 *
 * The request timeout bounds how LONG a download may take, not how BIG it
 * may be: materializing the whole body and comparing it against the
 * existing tarball keeps two full copies resident, so a misconfigured or
 * hostile endpoint could drive the extension host out of memory. The
 * declared Content-Length is refused up front; a response that declares no
 * length is read chunk by chunk and abandoned the moment it crosses.
 *
 * @param res - The response whose body to drain.
 * @param limit - Maximum bytes to accept.
 * @returns The body bytes, or null when the response is over the limit.
 */
async function readBoundedBody(res: Response, limit: number): Promise<Buffer | null> {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > limit) return null;
	if (!res.body) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > limit) return null;
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/**
 * Downloads the connected server's shell.tgz to the workspace's canonical
 * .rocketride/shell/shell.tgz and installs it at the workspace root.
 *
 * The tgz is the installable shell package (compiled lib + frozen contract
 * types + token CSS). Two steps, nothing else:
 *   1. Write the tarball to `<workspace>/.rocketride/shell/shell.tgz`.
 *   2. Run `pnpm install` at the workspace root so every app links it.
 *
 * A byte-identical tarball skips both steps — the workspace is already
 * linked to this exact package. Non-fatal by design: every failure path
 * resolves to a reasoned result instead of throwing.
 *
 * @param workspaceRoot - The workspace folder that owns .rocketride/.
 * @param fallbackTgz - Extension-packaged shell.tgz for offline use.
 * @returns The vendor result — path on success, the reason on failure.
 */
export async function vendorShellPackage(workspaceRoot: string, fallbackTgz?: string, clientFallbackTgz?: string): Promise<ShellVendorResult> {
	const logger = getLogger();
	const baseUrl = ConnectionManager.getInstance().getHttpUrl?.() || '';

	/**
	 * Fetches one server-vendored tarball, falling back to the
	 * extension-packaged copy when offline. Bounded — a hung response must
	 * fail the pass (reasoned fallback) instead of wedging the
	 * single-flight ensureShell memo forever. Tracks WHY the download path
	 * failed — that reason IS the user's error.
	 */
	const fetchTgz = async (route: string, label: string, fallback?: string): Promise<{ tgz: Buffer | null; source: string; failure: string }> => {
		let tgz: Buffer | null = null;
		let source = '';
		let failure = '';
		if (!baseUrl) {
			failure = `Not connected to a RocketRide server — the ${label} is served by the connected server.`;
		} else {
			const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
			try {
				const res = await fetch(new URL(route, base), { signal: AbortSignal.timeout(30_000) });
				if (res.ok) {
					const body = await readBoundedBody(res, MAX_VENDORED_TGZ_BYTES);
					if (body) {
						tgz = body;
						source = `${baseUrl}/${route}`;
					} else {
						failure = `The ${label} served by ${baseUrl} is larger than the ${MAX_VENDORED_TGZ_BYTES / (1024 * 1024)} MB limit — refusing the download.`;
					}
				} else {
					failure = `${baseUrl} does not serve the ${label} (HTTP ${res.status}).`;
				}
			} catch (err) {
				failure = `Cannot reach ${baseUrl} — is the server running? (${err instanceof Error ? err.message : String(err)})`;
			}
		}
		if (!tgz && fallback && fs.existsSync(fallback)) {
			tgz = fs.readFileSync(fallback);
			source = 'extension-packaged copy';
			logger.output(`[appdev] ${failure} Using the ${source} of the ${label}.`);
		}
		return { tgz, source, failure };
	};

	/** Writes one canonical tarball; returns true when the bytes changed. */
	const writeIfChanged = (dir: string, fileName: string, tgz: Buffer, source: string, label: string): boolean => {
		const tgzPath = path.join(dir, fileName);
		if (fs.existsSync(tgzPath) && tgz.equals(fs.readFileSync(tgzPath))) {
			logger.output(`[appdev] ${label} unchanged (${source}) — keeping ${tgzPath}`);
			return false;
		}
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tgzPath, tgz);
		logger.output(`[appdev] vendored ${label} from ${source} -> ${tgzPath} (${(tgz.length / 1024).toFixed(0)} KB)`);
		return true;
	};

	try {
		// step: fetch BOTH server-matched packages — the shell (the platform
		// package apps compile against) and the client SDK (the npm
		// registry's `rocketride` can lag the server badly, so apps pin the
		// server's own build the same way they pin the shell).
		const [shell, client] = await Promise.all([
			fetchTgz('client/shell', 'platform package (shell.tgz)', fallbackTgz),
			fetchTgz('client/typescript', 'client SDK package (rocketride.tgz)', clientFallbackTgz),
		]);
		if (!shell.tgz) {
			return { ok: false, reason: `${shell.failure} No packaged fallback copy is available — connect to a server and reopen this app.` };
		}

		const tgzPath = path.join(workspaceRoot, '.rocketride', 'shell', 'shell.tgz');
		let changed = writeIfChanged(path.join(workspaceRoot, '.rocketride', 'shell'), 'shell.tgz', shell.tgz, shell.source, 'shell package');
		if (client.tgz) {
			// Stable filename regardless of the versioned name the endpoint
			// serves — the file: spec in app package.json must never churn.
			changed = writeIfChanged(path.join(workspaceRoot, '.rocketride', 'client'), 'rocketride.tgz', client.tgz, client.source, 'client SDK package') || changed;
		} else {
			// Non-fatal: the shell alone still serves app work (the runtime
			// client is shell-shared); the client pin links on the next
			// connected open, exactly like an offline shell scaffold.
			logger.output(`[appdev] client SDK package unavailable (non-fatal): ${client.failure}`);
		}

		// step: unchanged packages — the workspace is already linked to them
		if (!changed) {
			return { ok: true, tgzPath };
		}

		// step: nothing to link into yet — a bare workspace (no root
		// manifest, no pnpm workspace file) gets the TARBALLS only, which is
		// the boot-time deliverable: agents and the scaffold find them at
		// the well-known .rocketride/ locations, and the first real install
		// (scaffold, pnpm add) links them.
		if (!fs.existsSync(path.join(workspaceRoot, 'package.json')) && !fs.existsSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'))) {
			logger.output('[appdev] platform packages vendored (no workspace manifest yet — install will link them when one exists)');
			return { ok: true, tgzPath };
		}

		// step: install at the workspace root — links the new tarball into
		// every app that depends on it. Routed through the WatchManager's
		// single-flight whenever it is registered: a private pnpm spawn here
		// ran BESIDE the watch/scaffold install on fresh workspaces, and two
		// pnpm processes on one node_modules corrupt the virtual store
		// (ERR_PNPM_EEXIST in symlinkAllModules). The direct spawn survives
		// only as the fallback for delegate-less contexts.
		if (workspaceInstallDelegate) {
			if (!(await workspaceInstallDelegate())) {
				return { ok: false, reason: 'Workspace pnpm install failed — the app Console carries the pnpm output.' };
			}
		} else {
			await runRootInstall(workspaceRoot);
		}
		logger.output(`[appdev] workspace install complete — apps are linked to the new shell package`);
		return { ok: true, tgzPath };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.output(`[appdev] shell package vendoring failed (non-fatal): ${reason}`);
		return { ok: false, reason };
	}
}
