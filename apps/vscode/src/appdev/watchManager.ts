// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * WatchManager — the App Builder inner loop's engine room.
 *
 * Per app: runs `rsbuild dev` in the app's folder (serves the MF remote on
 * its dev port and rebuilds on save), parses the process output for the dev
 * URL and build results, keeps the developer's PERSONAL dev overlay pointed
 * at the served bundle via `rrext_app_submission.register_dev` (re-registered
 * on every rebuild — that also keeps the overlay's idle TTL alive), and
 * notifies the App Builder panel: watch status for the DEV badge, and a
 * debounced preview reload on each successful rebuild.
 *
 * Lifecycle: started when an App Builder panel opens (setting-gated by
 * `rocketride.appdev.autoWatch`), stopped when the panel closes or the
 * extension deactivates. Stopping unregisters the overlay entry so the
 * shell drops the dev bundle.
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { ConnectionManager } from '../connection/connection';
import { extractInstallCause } from './appTypes';
import { getLogger } from '../shared/util/output';
import type { ScannedApp } from './appScan';
import type { AppScreenProvider, AppWatchStatus } from '../providers/AppScreenProvider';

// =============================================================================
// TYPES
// =============================================================================

/** One running watch session. */
interface WatchSession {
	app: ScannedApp;
	proc: ChildProcess;
	/** Dev server origin once parsed from output (http://localhost:<port>). */
	devOrigin?: string;
	/** Rebuild-reload debounce timer. */
	reloadTimer?: NodeJS.Timeout;
	/** Millisecond stamp when the current build started (for the badge). */
	buildStart?: number;
	/** Watches the app's package.json — a dep edit reinstalls and restarts. */
	pkgWatcher?: vscode.FileSystemWatcher;
	/** Debounce timer for package.json change bursts. */
	pkgTimer?: NodeJS.Timeout;
	/** Incomplete trailing line carried over between output chunks. */
	pending?: string;
}

// =============================================================================
// MANAGER
// =============================================================================

export class WatchManager {
	private sessions = new Map<string, WatchSession>();
	/** Apps mid-start (awaiting the shared install) — guards double-spawns. */
	private starting = new Set<string>();
	/**
	 * Single-flight memo for the WORKSPACE-GLOBAL install: concurrent watch
	 * starts for several apps await the same `pnpm install` at the workspace
	 * root. Unlike ensureShell's memo it is INVALIDATABLE — a package.json
	 * change (or a fresh scaffold) resets it so the next start reinstalls.
	 */
	private installPromise: Promise<boolean> | null = null;
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();

	constructor(private readonly appScreen: AppScreenProvider) {}

	// =========================================================================
	// PUBLIC
	// =========================================================================

	/** Whether a watch session is running for an app. */
	public isRunning(appId: string): boolean {
		return this.sessions.has(appId);
	}

	/**
	 * Invalidates the shared workspace install so the next start (or an
	 * explicit ensureInstalled) runs `pnpm install` again — called when a
	 * package.json changes or a fresh app is scaffolded into the workspace.
	 */
	public invalidateInstall(): void {
		this.installPromise = null;
	}

	/**
	 * Ensures the workspace-global install has run (single-flight). Safe to
	 * call from anywhere — scaffolding uses it to link a brand-new app
	 * without waiting for a watch session.
	 *
	 * @param triggerAppId - The app whose console carries the install output.
	 * @returns True when the install succeeded (or was already done).
	 */
	public ensureInstalled(triggerAppId?: string): Promise<boolean> {
		if (!this.installPromise) {
			this.installPromise = this.runWorkspaceInstall(triggerAppId).then((ok) => {
				// A failed install must not be memoized as done — the next
				// start retries instead of trusting a broken node_modules.
				if (!ok) this.installPromise = null;
				return ok;
			});
		}
		return this.installPromise;
	}

	/**
	 * Starts (or reuses) the watch session for an app.
	 *
	 * Awaits the shared workspace install first: package.json may have
	 * changed since the last session (or the app may be freshly scaffolded
	 * with no node_modules at all); the single-flight memo makes concurrent
	 * starts share one `pnpm install`. Only then does `rsbuild dev` spawn.
	 *
	 * @param app - The scanned workspace app to watch.
	 */
	public async start(app: ScannedApp): Promise<void> {
		if (this.sessions.has(app.id) || this.starting.has(app.id)) return;

		// Dependencies first — the starting guard means "don't double-spawn
		// while awaiting the shared install".
		this.starting.add(app.id);
		try {
			const installed = await this.ensureInstalled(app.id);
			if (!installed) return;
			// A session that appeared while installing wins — never double-spawn
			if (this.sessions.has(app.id)) return;
		} finally {
			this.starting.delete(app.id);
		}

		// Resolve the app-local rsbuild binary; the scaffolder pins it as a
		// devDependency. Falling back to `pnpm exec` covers hoisted setups.
		const spawnArgs = this.resolveRsbuild(app.folder);
		this.logger.output(`[appdev] watch start: ${app.id} (${spawnArgs.cmd} ${spawnArgs.args.join(' ')})`);
		this.console(app.id, 'log', '$ rsbuild dev');

		const proc = spawn(spawnArgs.cmd, [...spawnArgs.args, 'dev'], {
			cwd: app.folder,
			shell: spawnArgs.shell,
			env: { ...process.env, NO_COLOR: '1' },
		});

		const session: WatchSession = { app, proc, buildStart: Date.now() };
		this.sessions.set(app.id, session);
		this.notify(app.id, { state: 'building' });

		// package.json watcher: a dependency edit invalidates the shared
		// install and restarts THIS session (other apps' dev servers survive
		// a root install — pnpm only rewrites the changed project's links).
		// The install/restart loop DOES write package.json (the App Builder
		// open path rewires the shell spec via ensureShellDependency), but it
		// terminates: the rewrite early-returns once the spec is correct, so
		// the watcher fires at most one extra cycle. Disposed in stop() so
		// watcher lifetime tracks the session. Known edge: an edit landing
		// while the install is mid-flight is swallowed by the starting guard —
		// accepted (the debounce makes it rare, and the preview Reload button
		// recovers).
		session.pkgWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(app.folder), 'package.json'));
		const onPkgChange = (): void => {
			if (session.pkgTimer) clearTimeout(session.pkgTimer);
			session.pkgTimer = setTimeout(() => {
				this.logger.output(`[appdev] package.json changed: ${app.id} — reinstalling and restarting`);
				this.invalidateInstall();
				void this.restart(app);
			}, 800);
		};
		session.pkgWatcher.onDidChange(onPkgChange);
		session.pkgWatcher.onDidCreate(onPkgChange);

		// Parse stdout for the dev origin and build results
		proc.stdout?.on('data', (chunk: Buffer) => this.handleOutput(session, chunk.toString('utf8')));
		proc.stderr?.on('data', (chunk: Buffer) => this.handleOutput(session, chunk.toString('utf8')));

		proc.on('exit', (code) => {
			this.logger.output(`[appdev] watch exited (${code}): ${app.id}`);
			if (this.sessions.get(app.id) === session) {
				this.sessions.delete(app.id);
				this.notify(app.id, { state: 'idle' });
			}
		});
		proc.on('error', (err) => {
			this.logger.output(`[appdev] watch failed to start: ${app.id}: ${err.message}`);
			// Only tear down the entry this handler still owns — a restart may
			// have replaced the session under the same app id (same guard as exit).
			if (this.sessions.get(app.id) === session) {
				this.sessions.delete(app.id);
				this.notify(app.id, { state: 'error' });
			}
		});
	}

	/**
	 * Stops an app's watch session and drops its dev-overlay entry.
	 *
	 * @param appId - The app to stop watching.
	 */
	public async stop(appId: string): Promise<void> {
		const session = this.sessions.get(appId);
		if (!session) return;
		this.sessions.delete(appId);
		if (session.reloadTimer) clearTimeout(session.reloadTimer);
		if (session.pkgTimer) clearTimeout(session.pkgTimer);
		session.pkgWatcher?.dispose();
		try {
			// Windows: kill() only reaches the immediate process — rsbuild's
			// children (the dev server) survive and squat the port across
			// reloads. taskkill /T fells the whole tree.
			if (process.platform === 'win32' && session.proc.pid) {
				spawn('taskkill', ['/PID', String(session.proc.pid), '/T', '/F']);
			} else {
				session.proc.kill();
			}
		} catch { /* already gone */ }

		// Drop the overlay entry so the shell returns to the published bundle
		try {
			const client = this.connectionManager.getClient();
			if (client && this.connectionManager.isConnected()) {
				await client.call('rrext_app_submission', { subcommand: 'register_dev', moduleId: session.app.moduleId, unregister: true });
			}
		} catch { /* engine gone — the overlay's disconnect expiry covers it */ }
		this.notify(appId, { state: 'idle' });
	}

	/**
	 * Full session restart: kill the running dev server, reinstall deps, and
	 * spawn a fresh `rsbuild dev`. The preview Reload button routes here so a
	 * package.json edit (or a wedged dev server) is one click away from a
	 * clean state; the rebuilt bundle triggers the normal debounced preview
	 * reload when the new server reports its first successful build.
	 *
	 * @param app - The app whose session should restart.
	 */
	public async restart(app: ScannedApp): Promise<void> {
		await this.stop(app.id);
		await this.start(app);
	}

	/** Stops every session (extension deactivation). */
	public dispose(): void {
		for (const appId of [...this.sessions.keys()]) void this.stop(appId);
	}

	// =========================================================================
	// INSTALL
	// =========================================================================

	/**
	 * Runs `pnpm install` at the WORKSPACE root — one install shared by all
	 * apps (they are workspace members; pnpm materializes each member's
	 * node_modules links from the root). Badge state and installer output
	 * broadcast to every open panel: a global install belongs to all of
	 * them. A failure names the offending project through pnpm's own output.
	 *
	 * Assumes workspaceFolders[0] (same known limitation as ensureShell —
	 * apps in a second workspace root are not covered).
	 *
	 * @param triggerAppId - The app that initiated the install (error focus).
	 * @returns True when the install succeeded (or was a no-op).
	 */
	private runWorkspaceInstall(triggerAppId?: string): Promise<boolean> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) return Promise.resolve(false);
		this.appScreen.notifyWatchAll({ state: 'installing' });
		this.logger.output(`[appdev] pnpm install (workspace) at ${workspaceRoot}${triggerAppId ? ` — triggered by ${triggerAppId}` : ''}`);
		this.appScreen.notifyConsoleAll('log', `$ pnpm install --prefer-offline  (${workspaceRoot})`);
		return new Promise<boolean>((resolve) => {
			// Workspace model: no --ignore-workspace (the root workspace file
			// claims apps/*), no --no-lockfile (the root lockfile is the
			// honest record of what the workspace resolves).
			// --prefer-offline: resolve from the store when a range is already
			// satisfied, so one slow registry response cannot stall installs.
			const proc = spawn('pnpm', ['install', '--prefer-offline'], {
				cwd: workspaceRoot,
				shell: process.platform === 'win32',
				env: { ...process.env, NO_COLOR: '1' },
			});
			// Mirror installer output into every open panel's Console, and
			// accumulate it so a failure can NAME its cause.
			let output = '';
			proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); this.consoleAllLines('log', chunk.toString('utf8')); });
			proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); this.consoleAllLines('warn', chunk.toString('utf8')); });
			// Settle exactly once — exit, spawn-error, and the timeout race here.
			let settled = false;
			const finish = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(ok);
			};
			// A stalled install must not wedge the single-flight memo forever —
			// bound it and surface the failure like any other install error.
			// shell:true wraps pnpm in cmd.exe on Windows, so SIGKILL fells only
			// the wrapper while pnpm keeps running — taskkill /T fells the whole
			// tree, same approach as stop().
			const timer = setTimeout(() => {
				try {
					if (process.platform === 'win32' && proc.pid) {
						spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
					} else {
						proc.kill('SIGKILL');
					}
				} catch { /* already gone */ }
				const reason = 'pnpm install timed out after 10 minutes';
				this.logger.output('[appdev] workspace pnpm install timed out after 10 minutes');
				if (triggerAppId) this.appScreen.notifyError(triggerAppId, reason, 'pnpm install');
				this.appScreen.notifyWatchAll({ state: 'error', target: 'pnpm install', reason });
				finish(false);
			}, 10 * 60 * 1000);
			// 'close' (not 'exit'): stdio is flushed first, so extractInstallCause
			// reads the COMPLETE output — aligns with publish.ts and runRootInstall.
			proc.on('close', (code) => {
				if (code === 0) {
					this.appScreen.notifyConsoleAll('log', 'pnpm install: done');
					// Clear the broadcast 'installing' badge; running sessions
					// immediately re-assert their real state below.
					this.appScreen.notifyWatchAll({ state: 'idle' });
					for (const s of this.sessions.values()) {
						this.notify(s.app.id, { state: s.buildStart ? 'building' : 'ok', target: s.devOrigin?.replace(/^https?:\/\//, '') });
					}
					finish(true);
				} else {
					const reason = `pnpm install failed: ${extractInstallCause(output, code)}`;
					this.logger.output(`[appdev] workspace ${reason}`);
					if (triggerAppId) this.appScreen.notifyError(triggerAppId, reason, 'pnpm install');
					this.appScreen.notifyWatchAll({ state: 'error', target: 'pnpm install', reason });
					finish(false);
				}
			});
			proc.on('error', (err) => {
				const reason = `pnpm could not be started: ${err.message}`;
				this.logger.output(`[appdev] ${reason}`);
				if (triggerAppId) this.appScreen.notifyError(triggerAppId, reason, 'pnpm install');
				this.appScreen.notifyWatchAll({ state: 'error', target: 'pnpm install', reason });
				finish(false);
			});
		});
	}

	/**
	 * Splits raw workspace-install output into rows broadcast to every open
	 * panel's Console (blank lines dropped), mirroring the extension log.
	 *
	 * @param level - Row severity.
	 * @param text - Raw chunk (possibly multi-line).
	 */
	private consoleAllLines(level: 'log' | 'warn' | 'error', text: string): void {
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) {
				this.logger.output(`[appdev] ${trimmed}`);
				this.appScreen.notifyConsoleAll(level, trimmed);
			}
		}
	}

	/**
	 * Splits raw process output into rows for the panel Console (blank lines
	 * dropped), mirroring each line to the extension log.
	 *
	 * @param appId - The app the output belongs to.
	 * @param level - Row severity for the Console pane.
	 * @param text - Raw chunk (possibly multi-line).
	 */
	private consoleLines(appId: string, level: 'log' | 'warn' | 'error', text: string): void {
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) this.console(appId, level, trimmed);
		}
	}

	/** One console row → panel Console pane + extension log. */
	private console(appId: string, level: 'log' | 'warn' | 'error', text: string): void {
		this.logger.output(`[appdev] ${text}`);
		this.appScreen.notifyConsole(appId, level, text);
	}

	// =========================================================================
	// OUTPUT PARSING
	// =========================================================================

	/**
	 * Parses rsbuild output: captures the dev origin the first time it
	 * appears, then classifies build completions and failures.
	 *
	 * @param session - The owning watch session.
	 * @param chunk - Raw process output chunk.
	 */
	private handleOutput(session: WatchSession, chunk: string): void {
		// Chunks split mid-line at the pipe's whim — a marker torn across two
		// chunks would never match its regex. Carry the incomplete trailing
		// line over and only parse COMPLETE lines.
		const buffered = (session.pending ?? '') + chunk;
		const lines = buffered.split(/\r?\n/);
		session.pending = lines.pop() ?? '';
		if (lines.length === 0) return;
		const text = lines.join('\n');

		// Mirror the raw rsbuild output into the panel Console pane
		this.consoleLines(session.app.id, 'log', text);

		// Dev origin: "  ➜ Local:    http://localhost:3013/" (rsbuild banner)
		if (!session.devOrigin) {
			const m = /Local:\s+(http:\/\/[\w.-]+:\d+)/.exec(text);
			if (m) {
				session.devOrigin = m[1];
				this.logger.output(`[appdev] ${session.app.id} dev server at ${session.devOrigin}`);
				// The panel injects this entry straight into the preview shell
				// (postMessage — no server dependency); the overlay below only
				// serves embedder-less shells (F5's external browser).
				this.notifyDevEntry(session);
				void this.registerOverlay(session);
			}
		}

		// Build results: rsbuild prints "built in 1.24 s" / "build failed"
		if (/built in\s+[\d.]+/i.test(text)) {
			const durationMs = session.buildStart ? Date.now() - session.buildStart : undefined;
			session.buildStart = undefined;
			this.notify(session.app.id, { state: 'ok', durationMs, target: session.devOrigin?.replace(/^https?:\/\//, '') });
			// Fresh cache-busted entry FIRST (same-URL re-registration would
			// resolve to the browser-cached container — the stale-bundle bug),
			// then the overlay refresh and the debounced re-inject.
			this.notifyDevEntry(session);
			void this.registerOverlay(session);
			this.scheduleReload(session);
		} else if (/build failed|error {3}/i.test(text)) {
			session.buildStart = undefined;
			this.appScreen.notifyError(session.app.id, 'rsbuild build failed — see the Console pane for compiler output', 'rsbuild');
			this.notify(session.app.id, { state: 'error', target: session.devOrigin?.replace(/^https?:\/\//, ''), reason: 'The app failed to compile — the Console pane carries the compiler output.' });
		} else if (/building|compiling/i.test(text) && session.buildStart === undefined) {
			session.buildStart = Date.now();
			this.notify(session.app.id, { state: 'building', target: session.devOrigin?.replace(/^https?:\/\//, '') });
		}
	}

	// =========================================================================
	// OVERLAY + RELOAD
	// =========================================================================

	/**
	 * Announces the dev server entry to the panel with a per-build cache
	 * buster: a CHANGED entry URL is what makes the shell's force
	 * re-registration actually refetch the container instead of resolving
	 * the browser-cached script (chunks still resolve relative to the URL's
	 * directory, so the query hurts nothing).
	 *
	 * @param session - The session whose dev server has a fresh build.
	 */
	private notifyDevEntry(session: WatchSession): void {
		if (!session.devOrigin) return;
		this.appScreen.notifyDevServer(session.app.id, `${session.devOrigin}/remoteEntry.js?t=${Date.now()}`);
	}

	/** Points the caller's dev overlay at the served remoteEntry.js. */
	private async registerOverlay(session: WatchSession): Promise<void> {
		if (!session.devOrigin) return;
		try {
			const client = this.connectionManager.getClient();
			if (!client || !this.connectionManager.isConnected()) return;
			await client.call('rrext_app_submission', {
				subcommand: 'register_dev',
				moduleId: session.app.moduleId,
				url: `${session.devOrigin}/remoteEntry.js`,
				appId: session.app.id,
			});
		} catch (err) {
			this.logger.output(`[appdev] register_dev failed for ${session.app.id}: ${err}`);
		}
	}

	/** Debounced (300ms) preview reload after a successful rebuild. */
	private scheduleReload(session: WatchSession): void {
		if (session.reloadTimer) clearTimeout(session.reloadTimer);
		session.reloadTimer = setTimeout(() => {
			this.appScreen.notifyReload(session.app.id);
		}, 300);
	}

	/** Forwards a watch status to the app's panel DEV badge. */
	private notify(appId: string, status: AppWatchStatus): void {
		this.appScreen.notifyWatch(appId, status);
	}

	// =========================================================================
	// BINARY RESOLUTION
	// =========================================================================

	/** See {@link resolveRsbuildInvocation}. */
	private resolveRsbuild(appRoot: string): { cmd: string; args: string[]; shell: boolean } {
		return resolveRsbuildInvocation(appRoot);
	}
}

/**
 * Resolves how to invoke rsbuild for an app folder: the app-local bin
 * first (deterministic), `pnpm exec` as the fallback for hoisted trees.
 * Shared by the watch loop (`rsbuild dev`) and the publish flow's one-shot
 * `rsbuild build`.
 *
 * @param appRoot - The app's absolute folder path.
 */
export function resolveRsbuildInvocation(appRoot: string): { cmd: string; args: string[]; shell: boolean } {
	try {
		const binPath = require.resolve('@rsbuild/core/bin/rsbuild.js', { paths: [appRoot] });
		return { cmd: process.execPath, args: [binPath], shell: false };
	} catch {
		// --ignore-workspace keeps the exec scoped to the app folder — inside
		// an enclosing pnpm workspace a bare exec goes recursive across ITS
		// projects (ERR_PNPM_RECURSIVE_EXEC) instead of running the app's bin.
		return { cmd: 'pnpm', args: ['--ignore-workspace', 'exec', 'rsbuild'], shell: process.platform === 'win32' };
	}
}

/** Module-level accessor wiring (set once in extension activation). */
let instance: WatchManager | null = null;

/** Installs the singleton WatchManager (called from extension activation). */
export function initWatchManager(appScreen: AppScreenProvider): WatchManager {
	instance = new WatchManager(appScreen);
	return instance;
}

/** Returns the active WatchManager, or null before activation wiring. */
export function getWatchManager(): WatchManager | null {
	return instance;
}

/**
 * Ensures the watch session for an app is running (used by the App Screen
 * open path and F5). Honors the `rocketride.appdev.autoWatch` setting when
 * `force` is false.
 *
 * @param app - The app to watch.
 * @param force - True to start regardless of the autoWatch setting (F5).
 */
export async function ensureWatch(app: ScannedApp, force = false): Promise<void> {
	const manager = instance;
	if (!manager) return;
	const autoWatch = vscode.workspace.getConfiguration('rocketride.appdev').get<boolean>('autoWatch', true);
	if (!force && !autoWatch) return;
	await manager.start(app);
}
