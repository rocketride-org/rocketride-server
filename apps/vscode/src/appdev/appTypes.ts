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
export type ShellVendorResult = { ok: true; tgzPath: string } | { ok: false; reason: string };

// Single-flight memo for the workspace's ONE shell package: the first
// caller performs the vendor pass; concurrent callers (several App
// Builder panels, a scaffold racing an open) share the same in-flight
// promise; after a successful pass every later call resolves
// immediately. A failed result (offline, no packaged copy) clears the
// memo so the next open retries instead of caching failure for the
// whole session.
let ensureShellPromise: Promise<ShellVendorResult> | null = null;

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
	ensureShellPromise = vendorShellPackage(workspaceRoot, path.join(context.extensionPath, 'shell.tgz')).then((result) => {
		// vendorShellPackage never throws (non-fatal by design); a failure
		// clears the memo so a later open retries with a (possibly)
		// reachable server instead of caching the failure for the session.
		if (!result.ok) ensureShellPromise = null;
		return result;
	});
	return ensureShellPromise;
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
	try {
		ensureWorkspaceFile(workspaceRoot);
		ensureShellDependency(appFolder, path.join(workspaceRoot, '.rocketride', 'shell', 'shell.tgz'));
	} catch (err) {
		logger.output(`[appdev] wiring the shell package dependency failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
	const result = await ensureShell(context);
	if (!result.ok) {
		logger.output(`[appdev] shell package unavailable: ${result.reason}`);
	}
	return result;
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
			if (/^packages:/m.test(text)) {
				text = text.replace(/^packages:[^\n]*\n/m, (m) => `${m}  - 'apps/*'\n`);
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
 */
function ensureShellDependency(appFolder: string, pkgTgz: string): void {
	const logger = getLogger();
	const pkgJsonPath = path.join(appFolder, 'package.json');
	if (!fs.existsSync(pkgJsonPath)) return;
	// step: compute the app-relative file: spec with posix separators
	const rel = path.relative(appFolder, pkgTgz).split(path.sep).join('/');
	const spec = `file:${rel}`;
	// step: rewrite only when missing or different
	const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
	if (pkg.dependencies?.shell === spec) return;
	pkg.dependencies = { ...(pkg.dependencies ?? {}), shell: spec };
	fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
	logger.output(`[appdev] package.json: "shell": "${spec}"`);
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
		proc.on('error', reject);
		proc.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`pnpm install failed: ${extractInstallCause(output, code)}`));
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
	// step: prefer pnpm's own error markers, newest last
	const marked = lines.filter((l) => /ERR_PNPM|ENOENT|EACCES|EPERM|ERR!|error/i.test(l));
	if (marked.length > 0) return marked[marked.length - 1];
	// step: otherwise the last line of output beats a bare exit code
	return lines.length > 0 ? lines[lines.length - 1] : `exit code ${code}`;
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
export async function vendorShellPackage(workspaceRoot: string, fallbackTgz?: string): Promise<ShellVendorResult> {
	const logger = getLogger();
	const baseUrl = ConnectionManager.getInstance().getHttpUrl?.() || '';
	try {
		// step: fetch the stable-named tarball from the connected server
		// (the public /client/shell route, beside the SDK downloads),
		// falling back to the extension-packaged copy when offline. Track
		// WHY the download path failed — that reason IS the user's error.
		let tgz: Buffer | null = null;
		let source = '';
		let downloadFailure = '';
		if (!baseUrl) {
			downloadFailure = 'Not connected to a RocketRide server — the platform package (shell.tgz) is served by the connected server.';
		} else {
			const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
			try {
				const res = await fetch(new URL('client/shell', base));
				if (res.ok) {
					tgz = Buffer.from(await res.arrayBuffer());
					source = `${baseUrl}/client/shell`;
				} else {
					downloadFailure = `${baseUrl} does not serve the shell package (HTTP ${res.status}).`;
				}
			} catch (err) {
				downloadFailure = `Cannot reach ${baseUrl} — is the server running? (${err instanceof Error ? err.message : String(err)})`;
			}
		}
		if (!tgz && fallbackTgz && fs.existsSync(fallbackTgz)) {
			tgz = fs.readFileSync(fallbackTgz);
			source = 'extension-packaged copy';
			logger.output(`[appdev] ${downloadFailure} Using the ${source}.`);
		}
		if (!tgz) {
			return { ok: false, reason: `${downloadFailure} No packaged fallback copy is available — connect to a server and reopen this app.` };
		}

		const shellDir = path.join(workspaceRoot, '.rocketride', 'shell');
		const tgzPath = path.join(shellDir, 'shell.tgz');

		// step: unchanged package — the workspace is already linked to it
		if (fs.existsSync(tgzPath) && tgz.equals(fs.readFileSync(tgzPath))) {
			logger.output(`[appdev] shell package unchanged (${source}) — keeping ${tgzPath}`);
			return { ok: true, tgzPath };
		}

		// step: write the canonical tarball
		fs.mkdirSync(shellDir, { recursive: true });
		fs.writeFileSync(tgzPath, tgz);
		logger.output(`[appdev] vendored shell package from ${source} -> ${tgzPath} (${(tgz.length / 1024).toFixed(0)} KB)`);

		// step: install at the workspace root — links the new tarball into
		// every app that depends on it
		await runRootInstall(workspaceRoot);
		logger.output(`[appdev] workspace install complete — apps are linked to the new shell package`);
		return { ok: true, tgzPath };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.output(`[appdev] shell package vendoring failed (non-fatal): ${reason}`);
		return { ok: false, reason };
	}
}
