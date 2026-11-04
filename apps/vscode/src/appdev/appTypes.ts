// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Platform package vendoring — VS Code adapter.
 *
 * The wiring and vendoring rules (pnpm workspace claim, dependency wiring
 * through workspace-yaml overrides, bounded tarball downloads, the root
 * install) are the SDK's (`rocketride/app-pack`), shared with the CLI.
 * This module adds what only the editor has: the session memo (one vendor
 * pass per session, shared by every panel), the extension-packaged offline
 * fallbacks, the connected server's URL, and routing installs through the
 * WatchManager's single-flight.
 *
 * Called at scaffold (new apps) and on every App Builder open (refresh —
 * apps track the platform of the CONNECTED server).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDependencyWiring, ensureWorkspaceFile, runRootInstall, vendorPlatformPackages } from 'rocketride/app-pack';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';

export { extractInstallCause, isTransientLockError } from 'rocketride/app-pack';

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
		/** True when THIS pass changed dependency wiring — completed a
		 * manifest or added a workspace override — callers must invalidate
		 * any memoised install so the new resolution links. */
		rewired?: boolean;
	}
	| { ok: false; reason: string };

/** The SDK's narration, prefixed into the extension's output channel. */
const appdevLog = (line: string): void => getLogger().output(`[appdev] ${line}`);

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
	if (!workspaceRoot) return Promise.resolve({ ok: false, reason: 'No workspace folder is open. The platform package lives under the workspace root.' });
	ensureShellPromise = vendorPlatformPackages(workspaceRoot, {
		baseUrl: ConnectionManager.getInstance().getHttpUrl?.() || '',
		fallbackShellTgz: path.join(context.extensionPath, 'shell.tgz'),
		fallbackClientTgz: path.join(context.extensionPath, 'rocketride-client.tgz'),
		// Resolved at INSTALL time (after the downloads), not now: routed
		// through the WatchManager's single-flight whenever it is registered
		// by then; a direct root install is the delegate-less fallback.
		install: async () => {
			if (workspaceInstallDelegate) return workspaceInstallDelegate();
			await runRootInstall(workspaceRoot);
			return true;
		},
		log: appdevLog,
	}).then((result): ShellVendorResult => {
		// vendorPlatformPackages never throws (non-fatal by design); a failure
		// clears the memo so a later open retries with a (possibly)
		// reachable server instead of caching the failure for the session.
		if (!result.ok) {
			ensureShellPromise = null;
			return result;
		}
		return { ok: true, tgzPath: result.tgzPath };
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
 * Ensures the app's platform dependencies RESOLVE — via the manifest's own
 * portable spec or a workspace-yaml override, never by rewriting app files
 * — then ensures the workspace's shared vendor pass has run (see
 * ensureShell — one download + install per session, shared by all
 * consumers).
 *
 * Wiring runs FIRST, before any download: specs and overrides name the
 * well-known workspace location, valid before the package has ever been
 * downloaded, so an offline scaffold still wires correctly and simply
 * links on the next connected open.
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
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) return { ok: false, reason: 'No workspace folder is open. The platform package lives under the workspace root.' };
	// Wiring failures FAIL the pass: an app whose workspace file or
	// dependency wiring could not be written will not link the platform
	// package, so pretending success would only defer the error to a
	// confusing place.
	try {
		ensureWorkspaceFile(workspaceRoot, appdevLog);
	} catch (err) {
		const reason = `Could not prepare the workspace file: ${err instanceof Error ? err.message : String(err)}`;
		appdevLog(reason);
		return { ok: false, reason };
	}
	let rewired = false;
	try {
		rewired = ensureDependencyWiring(appFolder, workspaceRoot, appdevLog);
	} catch (err) {
		const reason = `Could not wire the platform dependencies into ${appFolder}: ${err instanceof Error ? err.message : String(err)}`;
		appdevLog(reason);
		return { ok: false, reason };
	}
	const result = await ensureShell(context);
	if (!result.ok) {
		appdevLog(`shell package unavailable: ${result.reason}`);
		return result;
	}
	// Success carries whether this pass rewired the dependency spec, so the
	// caller can invalidate a pre-rewire install memo.
	return { ...result, rewired };
}
