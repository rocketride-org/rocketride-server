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
}

// =============================================================================
// MANAGER
// =============================================================================

export class WatchManager {
	private sessions = new Map<string, WatchSession>();
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
	 * Starts (or reuses) the watch session for an app.
	 *
	 * @param app - The scanned workspace app to watch.
	 */
	public async start(app: ScannedApp): Promise<void> {
		if (this.sessions.has(app.id)) return;

		// Resolve the app-local rsbuild binary; the scaffolder pins it as a
		// devDependency. Falling back to `pnpm exec` covers hoisted setups.
		const spawnArgs = this.resolveRsbuild(app.folder);
		this.logger.output(`[appdev] watch start: ${app.id} (${spawnArgs.cmd} ${spawnArgs.args.join(' ')})`);

		const proc = spawn(spawnArgs.cmd, [...spawnArgs.args, 'dev'], {
			cwd: app.folder,
			shell: spawnArgs.shell,
			env: { ...process.env, NO_COLOR: '1' },
		});

		const session: WatchSession = { app, proc, buildStart: Date.now() };
		this.sessions.set(app.id, session);
		this.notify(app.id, { state: 'building' });

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
			this.sessions.delete(app.id);
			this.notify(app.id, { state: 'error' });
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
		try {
			session.proc.kill();
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

	/** Stops every session (extension deactivation). */
	public dispose(): void {
		for (const appId of [...this.sessions.keys()]) void this.stop(appId);
	}

	// =========================================================================
	// OUTPUT PARSING
	// =========================================================================

	/**
	 * Parses one chunk of rsbuild output: captures the dev origin the first
	 * time it appears, then classifies build completions and failures.
	 *
	 * @param session - The owning watch session.
	 * @param text - Raw process output chunk.
	 */
	private handleOutput(session: WatchSession, text: string): void {
		// Dev origin: "  ➜ Local:    http://localhost:3013/" (rsbuild banner)
		if (!session.devOrigin) {
			const m = /Local:\s+(http:\/\/[\w.-]+:\d+)/.exec(text);
			if (m) {
				session.devOrigin = m[1];
				this.logger.output(`[appdev] ${session.app.id} dev server at ${session.devOrigin}`);
				void this.registerOverlay(session);
			}
		}

		// Build results: rsbuild prints "built in 1.24 s" / "build failed"
		if (/built in\s+[\d.]+/i.test(text)) {
			const durationMs = session.buildStart ? Date.now() - session.buildStart : undefined;
			session.buildStart = undefined;
			this.notify(session.app.id, { state: 'ok', durationMs, target: session.devOrigin?.replace(/^https?:\/\//, '') });
			// Keep the overlay fresh (also renews its idle TTL), then reload
			void this.registerOverlay(session);
			this.scheduleReload(session);
		} else if (/build failed|error {3}/i.test(text)) {
			session.buildStart = undefined;
			this.notify(session.app.id, { state: 'error', target: session.devOrigin?.replace(/^https?:\/\//, '') });
		} else if (/building|compiling/i.test(text) && session.buildStart === undefined) {
			session.buildStart = Date.now();
			this.notify(session.app.id, { state: 'building', target: session.devOrigin?.replace(/^https?:\/\//, '') });
		}
	}

	// =========================================================================
	// OVERLAY + RELOAD
	// =========================================================================

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

	/**
	 * Resolves how to invoke rsbuild for an app folder: the app-local bin
	 * first (deterministic), `pnpm exec` as the fallback for hoisted trees.
	 *
	 * @param appRoot - The app's absolute folder path.
	 */
	private resolveRsbuild(appRoot: string): { cmd: string; args: string[]; shell: boolean } {
		try {
			const binPath = require.resolve('@rsbuild/core/bin/rsbuild.js', { paths: [appRoot] });
			return { cmd: process.execPath, args: [binPath], shell: false };
		} catch {
			return { cmd: 'pnpm', args: ['exec', 'rsbuild'], shell: process.platform === 'win32' };
		}
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
