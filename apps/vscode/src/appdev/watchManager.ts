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
 * at the served bundle via `rrext_deploy_app.register_dev` (re-registered
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
import * as path from 'path';
import { existsSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { ConnectionManager } from '../connection/connection';
import { extractInstallCause, isTransientLockError, setWorkspaceInstallDelegate } from './appTypes';
import { getLogger } from '../shared/util/output';
import { DEV_SESSION_NONCE } from './devSession';
import { appIconDataUri } from './appScan';
import type { ScannedApp } from './appScan';
import type { AppScreenProvider, AppWatchStatus } from '../providers/AppScreenProvider';

// =============================================================================
// TYPES
// =============================================================================

/** One running watch session. Every session is OWNED — the manager spawned
    its process tree (under the guard wrapper, whose stdin tether kills the
    server when this extension host dies — see doStart) and observes its exit. */
interface WatchSession {
	app: ScannedApp;
	/** The spawned dev-server tree. */
	proc: ChildProcess;
	/** Millisecond stamp of the spawn (crash-loop guard input). */
	startedAt: number;
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
	/** Incomplete trailing STDOUT line carried between chunks. */
	pendingOut?: string;
	/** Incomplete trailing STDERR line carried between chunks — a SEPARATE
	    carry: one shared buffer spliced fragments of one stream into the
	    middle of the other stream's line. */
	pendingErr?: string;
	/** Deferred-teardown timer while the session LINGERS after its panel
	    closed; a reopen inside the window cancels it and revives. */
	lingerTimer?: NodeJS.Timeout;
	/** Identifies the CURRENT linger. The deferred teardown carries the token
	    it was scheduled with and only fires when the app's live session still
	    bears it — a revive clears it, and a replacement session (an exit +
	    fresh start) never inherits it, so an already-expired linger can never
	    tear down a session the user just reopened. */
	lingerToken?: number;
	/** The app's manifest icon as a data: URI, resolved ONCE per session
	    ('' when absent/unreadable) — registerOverlay re-fires on every
	    rebuild and must not re-read a 256 KiB file each time. */
	iconUri?: string;
}

// =============================================================================
// MANAGER
// =============================================================================

export class WatchManager {
	private sessions = new Map<string, WatchSession>();
	/**
	 * THE CATALOG DISCIPLINE: every lifecycle operation for an app —
	 * start, stop, restart — is appended to that app's serialized chain
	 * and runs alone. Interleaving is impossible by construction (no
	 * "stop raced a half-started spawn", no double-spawn windows), and a
	 * stop issued during a start simply runs right after it — exactly the
	 * user's intent when closing a still-spinning panel.
	 */
	private chains = new Map<string, Promise<unknown>>();
	/** Per-app readiness: resolves with the dev origin once the server is
	    actually serving (spawned and parsed); replaced per start. */
	private readiness = new Map<string, { promise: Promise<string>; resolve: (origin: string) => void; reject: (err: Error) => void }>();
	/** Consecutive quick-death respawns per app (crash-loop guard). */
	private respawnStrikes = new Map<string, number>();
	/**
	 * Serialized single-flight memo for the WORKSPACE-GLOBAL install. Concurrent
	 * watch starts for several apps await the SAME `pnpm install` at the
	 * workspace root (the apps are workspace members sharing one node_modules),
	 * and two installs must NEVER overlap — concurrent pnpm runs on one root
	 * corrupt the store and trip EPERM on Windows during pnpm's atomic renames.
	 *
	 * `installGen` is the generation the workspace currently WANTS installed;
	 * invalidateInstall() bumps it (a package.json change or a rewired shell
	 * spec). `install` memoizes the run for one generation: when its gen matches
	 * installGen the memo is reused (concurrent starts collapse into one); when
	 * a newer generation is requested the fresh run is CHAINED onto the tail of
	 * any in-flight one rather than started concurrently.
	 */
	private install: { gen: number; promise: Promise<boolean> } | null = null;
	private installGen = 0;
	/** Monotonic source of linger tokens (see WatchSession.lingerToken). */
	private lingerSeq = 0;
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();

	constructor(
		private readonly appScreen: AppScreenProvider,
		/** Absolute path to the shipped devServerGuard.cjs (see doStart). */
		private readonly guardPath: string,
	) {
		// The dev overlay registration lives server-side and EXPIRES on
		// disconnect. A reconnect (org switch, network blip) therefore leaves
		// every running session unregistered until its next rebuild happens to
		// re-register it — re-register eagerly so embedder-less shells (F5's
		// external browser) regain the override without waiting on a save.
		this.connectionManager.on('shell:statusChange', this.onStatusChange);

		// THE one install door: the shell-vendor pass (appTypes) must never
		// spawn its own pnpm beside this manager's single-flight — two pnpm
		// processes on one node_modules half-write the virtual store
		// (ERR_PNPM_EEXIST in symlinkAllModules). Registered as an injected
		// delegate (appTypes cannot import this module back — cycle). The
		// tarball has just changed whenever the delegate runs, so bump the
		// generation for a guaranteed-fresh run CHAINED behind any in-flight
		// install.
		setWorkspaceInstallDelegate(() => {
			this.invalidateInstall();
			return this.ensureInstalled();
		});
	}

	/** Bound reconnect listener (see constructor); removed in dispose(). */
	private onStatusChange = (): void => {
		if (!this.connectionManager.isConnected()) return;
		for (const session of this.sessions.values()) {
			if (session.devOrigin) void this.registerOverlay(session);
		}
	};

	// =========================================================================
	// PUBLIC
	// =========================================================================

	/** Whether a watch session is running for an app. */
	public isRunning(appId: string): boolean {
		return this.sessions.has(appId);
	}

	/**
	 * Marks the shared workspace install stale so the next start (or an explicit
	 * ensureInstalled) runs `pnpm install` again — called when a package.json
	 * changes or a fresh app is scaffolded into the workspace.
	 *
	 * Bumps the generation rather than dropping an in-flight install: the
	 * running pnpm keeps going and the fresh install CHAINS after it (see
	 * ensureInstalled), so two installs never race on the shared node_modules.
	 */
	public invalidateInstall(): void {
		this.installGen++;
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
		// Reuse the memo when it already targets the generation the workspace
		// wants — this collapses concurrent starts at the same generation into
		// a single install.
		if (this.install && this.install.gen === this.installGen) return this.install.promise;

		// A newer generation is wanted (or nothing has installed yet): run a
		// FRESH install, but CHAIN it after any in-flight one so two pnpm
		// processes never touch the shared node_modules at once. A superseded
		// in-flight install still runs to completion (cancelling mid-rename is
		// what corrupts the store); its result is simply discarded — only this
		// run, targeting `gen`, decides the outcome.
		const gen = this.installGen;
		const prior = this.install?.promise ?? Promise.resolve(true);
		const promise = prior
			.catch(() => false)
			.then(() => this.runWorkspaceInstall(triggerAppId))
			.then((ok) => {
				// A failed install at the still-current generation must not be
				// memoized as done — drop it so the next start retries. If a
				// newer generation has already superseded this run, leave the
				// memo (now pointing at that newer run) untouched.
				if (!ok && this.install?.gen === gen) this.install = null;
				return ok;
			});
		this.install = { gen, promise };
		return promise;
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
	 * @param opts - respawn: this start is crash recovery — it re-checks the
	 *               panel gate when its turn on the chain arrives.
	 */
	public start(app: ScannedApp, opts?: { respawn?: boolean }): Promise<void> {
		return this.enqueue(app.id, () => this.doStart(app, opts?.respawn === true));
	}

	/**
	 * Awaitable readiness for an app's dev server: resolves with the served
	 * origin (http://localhost:<port>) once it is actually serving (spawned
	 * and its banner parsed). Rejects when the start fails or the session is
	 * stopped first. Undefined when the app was never started.
	 *
	 * @param appId - The app to await.
	 */
	public whenReady(appId: string): Promise<string> | undefined {
		return this.readiness.get(appId)?.promise;
	}

	/**
	 * Appends an operation to the app's serialized chain (see `chains`).
	 * Failures propagate to THIS caller but never break the chain for the
	 * next operation.
	 */
	private enqueue<T>(appId: string, op: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(appId) ?? Promise.resolve();
		const next = prev.then(op, op);
		this.chains.set(appId, next.catch(() => undefined));
		return next;
	}

	/** Installs a fresh (pending) readiness record for a start attempt. */
	private createReadiness(appId: string): void {
		let resolve!: (origin: string) => void;
		let reject!: (err: Error) => void;
		const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
		// Nobody is obliged to await readiness — swallow the rejection so an
		// unawaited failed start never surfaces as an unhandled rejection.
		promise.catch(() => undefined);
		this.readiness.set(appId, { promise, resolve, reject });
	}

	/** Settles the app's readiness with its served origin (no-op if settled). */
	private resolveReadiness(appId: string, origin: string): void {
		this.readiness.get(appId)?.resolve(origin);
	}

	/** Fails the app's readiness (no-op when already settled). */
	private rejectReadiness(appId: string, reason: string): void {
		this.readiness.get(appId)?.reject(new Error(reason));
	}

	/** The start transition — runs alone on the app's chain. */
	private async doStart(app: ScannedApp, respawn = false): Promise<void> {
		// A crash respawn re-checks its gate ON the chain: the panel may have
		// closed between the exit handler's check and this turn — spawning
		// then would leave a server nothing ever stops (the dispose-time stop
		// already ran and found no session).
		if (respawn && !this.appScreen.hasPanel(app.id)) return;
		const existing = this.sessions.get(app.id);
		if (existing) {
			// LINGER REVIVE: the panel closed and reopened inside the grace
			// window — the server never stopped, so reopening is instant:
			// cancel the deferred teardown and re-announce the live server.
			// Gate on the TOKEN as well as the timer: the timer callback
			// clears lingerTimer and then ENQUEUES its teardown, so a start
			// queued behind it sees lingerTimer undefined while the expiry
			// (which captured the token) is still pending on the chain.
			if (existing.lingerTimer || existing.lingerToken !== undefined) {
				if (existing.lingerTimer) clearTimeout(existing.lingerTimer);
				existing.lingerTimer = undefined;
				// Drop the token so an already-fired linger's queued teardown
				// (which captured the old token) no longer matches this session.
				existing.lingerToken = undefined;
				this.logger.output(`[appdev] revived lingering dev server for ${app.id}`);
				this.console(app.id, 'log', 'reopened within the linger window — reusing the running dev server');
				this.notify(app.id, { state: 'ok', target: existing.devOrigin?.replace(/^https?:\/\//, '') });
				this.notifyDevEntry(existing);
				void this.registerOverlay(existing);
				this.scheduleReload(existing);
			}
			return;
		}

		// Fresh readiness for this start attempt; consumers awaiting the
		// previous (stopped) session's promise were already settled.
		this.createReadiness(app.id);

		// Dependencies first (single-flight across concurrent app starts).
		const installed = await this.ensureInstalled(app.id);
		if (!installed) {
			this.rejectReadiness(app.id, 'workspace install failed');
			return;
		}

		// Resolve the app-local rsbuild binary; the scaffolder pins it as a
		// devDependency. Falling back to `pnpm exec` covers hoisted setups.
		const spawnArgs = this.resolveRsbuild(app.folder);
		this.logger.output(`[appdev] watch start: ${app.id} (${spawnArgs.cmd} ${spawnArgs.args.join(' ')})`);
		this.console(app.id, 'log', '$ rsbuild dev');

		// The server runs under the GUARD wrapper — a liveness tether to this
		// extension host. The guard's stdin is a pipe from this process; any
		// death of the host (crash, window reload, EDH stop, hard kill)
		// closes it and the guard fells its own tree, so dev-server orphans
		// are structurally impossible. The guard passes rsbuild's output
		// through verbatim and mirrors its exit code, so parsing and crash
		// detection below see the server as before.
		const proc = spawn(process.execPath, [this.guardPath, String(process.pid), spawnArgs.shell ? '1' : '0', spawnArgs.cmd, ...spawnArgs.args, 'dev'], {
			cwd: app.folder,
			env: { ...process.env, NO_COLOR: '1' },
			// Never allocate a console window for the guard or its tree.
			windowsHide: true,
			// POSIX: make the guard its own process GROUP (rsbuild joins it)
			// so the guard's die() can fell the whole tree with one group
			// signal. On Windows the guard kills its subtree itself via
			// direct syscalls (see devServerGuard.cjs) — stop() only closes
			// the guard's stdin, on both platforms.
			detached: process.platform !== 'win32',
		});

		const session: WatchSession = { app, proc, startedAt: Date.now(), buildStart: Date.now() };
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
		proc.stdout?.on('data', (chunk: Buffer) => this.handleOutput(session, chunk.toString('utf8'), 'stdout'));
		proc.stderr?.on('data', (chunk: Buffer) => this.handleOutput(session, chunk.toString('utf8'), 'stderr'));

		proc.on('exit', (code) => {
			this.logger.output(`[appdev] watch exited (${code}): ${app.id}`);
			// Intentional stops (doStop, restart) delete the session BEFORE the
			// kill, so an exit that still owns its entry is a CRASH.
			if (this.sessions.get(app.id) !== session) return;
			this.sessions.delete(app.id);
			this.rejectReadiness(app.id, `dev server exited (${code})`);
			// Flush carried partial lines so a crashing server's last words
			// are not silently swallowed with its session.
			if (session.pendingOut?.trim()) this.consoleLines(app.id, 'log', session.pendingOut);
			if (session.pendingErr?.trim()) this.consoleLines(app.id, 'warn', session.pendingErr);
			this.disposeSessionResources(session);

			// Crash recovery: while the app's panel is open, a dead dev server
			// respawns itself — bounded, so a server that dies on every boot
			// cannot loop forever. Surviving the window resets the streak.
			if (this.appScreen.hasPanel(app.id)) {
				const quickDeath = Date.now() - session.startedAt < WatchManager.RESPAWN_WINDOW_MS;
				const strikes = quickDeath ? (this.respawnStrikes.get(app.id) ?? 0) + 1 : 1;
				this.respawnStrikes.set(app.id, strikes);
				if (strikes <= WatchManager.MAX_RESPAWNS) {
					this.console(app.id, 'warn', `dev server exited (${code}) — respawning (attempt ${strikes}/${WatchManager.MAX_RESPAWNS})`);
					void this.start(app, { respawn: true });
					return;
				}
				this.console(app.id, 'error', `dev server exited ${strikes} times in a row — giving up. Reload retries with a fresh install.`);
				this.notify(app.id, { state: 'error', target: 'dev server', reason: 'The dev server keeps exiting — the Console pane carries its last output. Reload retries.' });
				return;
			}
			this.notify(app.id, { state: 'idle' });
		});
		proc.on('error', (err) => {
			this.logger.output(`[appdev] watch failed to start: ${app.id}: ${err.message}`);
			// Only tear down the entry this handler still owns — a restart may
			// have replaced the session under the same app id (same guard as exit).
			// No respawn: a spawn failure (missing binary, EPERM) is not going
			// to succeed on a retry — the Reload button is the recovery.
			if (this.sessions.get(app.id) === session) {
				this.sessions.delete(app.id);
				this.rejectReadiness(app.id, err.message);
				this.disposeSessionResources(session);
				this.notify(app.id, { state: 'error' });
			}
		});
	}

	/** A death inside this window after start counts toward the crash-loop guard. */
	private static readonly RESPAWN_WINDOW_MS = 30_000;
	/** Auto-respawns allowed per quick-death streak before giving up. */
	private static readonly MAX_RESPAWNS = 3;

	/**
	 * Releases a dead session's timers and watchers. Without this, a crashed
	 * session's package.json watcher outlives it and fires restarts for a
	 * session that no longer exists — and double-fires once a respawned
	 * session installs its own watcher on the same file.
	 */
	private disposeSessionResources(session: WatchSession): void {
		if (session.reloadTimer) clearTimeout(session.reloadTimer);
		if (session.pkgTimer) clearTimeout(session.pkgTimer);
		session.pkgWatcher?.dispose();
	}

	/**
	 * Stops an app's watch session and drops its dev-overlay entry.
	 *
	 * Default (panel close) is a LINGERING stop: the server keeps running
	 * for a grace window so reopening the .rrapp is instant — a very common
	 * flow while iterating. The teardown only executes when the window
	 * expires unrevived. `immediate` (restart, deactivation) skips the
	 * grace and tears down now.
	 *
	 * @param appId - The app to stop watching.
	 * @param opts - immediate: tear down now, no linger.
	 */
	public stop(appId: string, opts?: { immediate?: boolean }): Promise<void> {
		// Chained after any in-flight start: closing a still-spinning panel
		// stops the session the moment it exists — never a missed kill.
		return this.enqueue(appId, () => this.doStop(appId, opts?.immediate === true));
	}

	/** Grace window a closed panel's dev server keeps running (revive-on-reopen). */
	private static readonly LINGER_MS = 60_000;

	/** The stop transition — runs alone on the app's chain. */
	private async doStop(appId: string, immediate: boolean): Promise<void> {
		const session = this.sessions.get(appId);
		if (!session) return;

		if (!immediate) {
			// LINGER: leave the server (and its overlay registration) running;
			// schedule the real teardown. A reopen inside the window cancels
			// it (doStart's revive path) and reuses the live server.
			if (session.lingerTimer) return; // already lingering
			// Stamp this linger with a token; the deferred teardown captures it
			// and only tears down while the live session still bears the same
			// token (guards a session the user reopened after the timer fired).
			const token = ++this.lingerSeq;
			session.lingerToken = token;
			this.logger.output(`[appdev] ${appId}: panel closed — dev server lingers ${WatchManager.LINGER_MS / 1000}s for a fast reopen`);
			session.lingerTimer = setTimeout(() => {
				session.lingerTimer = undefined;
				void this.enqueue(appId, () => this.doLingerExpiry(appId, token));
			}, WatchManager.LINGER_MS);
			return;
		}

		if (session.lingerTimer) {
			clearTimeout(session.lingerTimer);
			session.lingerTimer = undefined;
		}
		session.lingerToken = undefined;
		this.rejectReadiness(appId, 'watch stopped');
		this.sessions.delete(appId);
		if (session.reloadTimer) clearTimeout(session.reloadTimer);
		if (session.pkgTimer) clearTimeout(session.pkgTimer);
		session.pkgWatcher?.dispose();
		try {
			// The tether IS the stop verb: closing the guard's stdin tells it
			// to fell its own tree — the guard owns every process below
			// itself, and this watcher performs NO tree logic (Windows tree
			// walks from out here were exactly what leaked orphans). AWAITED:
			// restart() runs stop()→start() back-to-back, and the guard's
			// verified cleanup must release the port before the new spawn
			// probes it — otherwise rsbuild silently bumps to the next free
			// port and the preview's registration points at a zombie (the
			// unkillable reload loop).
			if (session.proc.pid) {
				const exited = new Promise<boolean>((resolve) => {
					session.proc.once('exit', () => resolve(true));
				});
				try {
					session.proc.stdin?.destroy();
				} catch { /* pipe already closed — the guard is reacting */ }
				const finished = await Promise.race([
					exited,
					new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
				]);
				if (!finished) {
					// A wedged guard is the ONLY case the watcher touches the
					// tree, and only as a last resort (best-effort by nature).
					this.logger.output(`[appdev] watch stop: guard for ${appId} ignored stdin close — escalating`);
					const pid = session.proc.pid;
					if (process.platform === 'win32') {
						await new Promise<void>((resolve) => {
							const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
							killer.on('exit', () => resolve());
							killer.on('error', () => resolve());
							setTimeout(resolve, 3000);
						});
					} else {
						try {
							process.kill(-pid, 'SIGKILL');
						} catch { /* group already gone */ }
					}
				}
			} else {
				session.proc.kill();
			}
		} catch { /* already gone */ }

		// Drop the overlay entry so the shell returns to the published bundle
		try {
			const client = this.connectionManager.getClient();
			if (client && this.connectionManager.isConnected()) {
				await client.call('rrext_deploy_app', { subcommand: 'register_dev', moduleId: session.app.moduleId, unregister: true });
			}
		} catch { /* engine gone — the overlay's disconnect expiry covers it */ }
		this.notify(appId, { state: 'idle' });
	}

	/**
	 * The deferred teardown a lingering stop schedules, gated on its token.
	 *
	 * It only proceeds when the app's CURRENT session is still the one that
	 * scheduled this linger (same token). A revive clears the token, and a
	 * replacement session — the previous server exiting on its own, then a
	 * fresh start racing behind this already-fired timer — never inherits it,
	 * so a stale linger cannot tear down a session the user just reopened.
	 *
	 * @param appId - The app whose linger is expiring.
	 * @param token - The token stamped when this linger was scheduled.
	 */
	private async doLingerExpiry(appId: string, token: number): Promise<void> {
		const session = this.sessions.get(appId);
		if (!session || session.lingerToken !== token) return;
		await this.doStop(appId, true);
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
		// A manual restart earns a fresh crash-loop allowance — the user is
		// explicitly retrying, so a previous give-up must not veto the respawn.
		this.respawnStrikes.delete(app.id);
		// A restart's whole point is a FRESH server — never linger the old one.
		await this.stop(app.id, { immediate: true });
		await this.start(app);
	}

	/** Stops every session (extension deactivation) — no linger on exit. */
	public dispose(): void {
		this.connectionManager.off('shell:statusChange', this.onStatusChange);
		for (const appId of [...this.sessions.keys()]) void this.stop(appId, { immediate: true });
	}

	// NOTE: there is deliberately no orphan reaping here. Dev servers run
	// under the guard wrapper (see doStart), whose stdin tether guarantees
	// they die with this extension host — orphans are prevented, not hunted.

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
	private async runWorkspaceInstall(triggerAppId?: string): Promise<boolean> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) return false;
		this.appScreen.notifyWatchAll({ state: 'installing' });
		this.logger.output(`[appdev] pnpm install (workspace) at ${workspaceRoot}${triggerAppId ? ` — triggered by ${triggerAppId}` : ''}`);
		this.appScreen.notifyConsoleAll('log', `$ pnpm install --prefer-offline  (${workspaceRoot})`);

		// Windows holds transient handles on files under node_modules/.pnpm
		// (antivirus scan, Search indexer, an editor watching the tree), so
		// pnpm's atomic rename step intermittently fails with EPERM/EBUSY/
		// ENOTEMPTY even though the dependency graph is fine. The handle clears
		// on its own, so retry the WHOLE install a few times on that specific
		// signature — never on a genuine resolution or build failure. A
		// backoff between attempts gives the OS time to release the handle.
		const MAX_ATTEMPTS = 3;
		let result = await this.spawnInstallOnce(workspaceRoot);
		// A terminal failure (a timeout or a spawn error carries failureReason)
		// is NEVER retried — retrying a timed-out install could start a second
		// pnpm on the shared root while the first tree is still dying, even if
		// its accumulated output happens to carry a transient-lock signature.
		for (let attempt = 1; !result.ok && !result.failureReason && attempt < MAX_ATTEMPTS && isTransientLockError(result.output); attempt++) {
			const note = `pnpm install hit a transient Windows file lock — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`;
			this.logger.output(`[appdev] ${note}`);
			this.appScreen.notifyConsoleAll('warn', note);
			await new Promise((r) => setTimeout(r, 1500 * attempt));
			result = await this.spawnInstallOnce(workspaceRoot);
		}

		if (result.ok) {
			this.appScreen.notifyConsoleAll('log', 'pnpm install: done');
			// Clear the broadcast 'installing' badge; running sessions
			// immediately re-assert their real state below.
			this.appScreen.notifyWatchAll({ state: 'idle' });
			for (const s of this.sessions.values()) {
				this.notify(s.app.id, { state: s.buildStart ? 'building' : 'ok', target: s.devOrigin?.replace(/^https?:\/\//, '') });
			}
			return true;
		}
		// A timeout/spawn failure carries its own reason; everything else names
		// its cause from the accumulated output.
		const reason = result.failureReason ?? `pnpm install failed: ${extractInstallCause(result.output, result.code)}`;
		this.logger.output(`[appdev] workspace ${reason}`);
		if (triggerAppId) this.appScreen.notifyError(triggerAppId, reason, 'pnpm install');
		this.appScreen.notifyWatchAll({ state: 'error', target: 'pnpm install', reason });
		return false;
	}

	/**
	 * Runs ONE `pnpm install --prefer-offline` at the workspace root and
	 * resolves to its outcome — never reports to the UI itself, so the caller
	 * (runWorkspaceInstall) owns retry decisions and the final badge/error.
	 *
	 * Installer output still streams live into every panel's Console as it
	 * arrives, and is accumulated so a failure can name its cause.
	 *
	 * @param workspaceRoot - The workspace folder pnpm installs into.
	 * @returns ok + the combined output + exit code; failureReason is set only
	 *          for terminal, non-retriable failures (timeout, spawn error).
	 */
	private spawnInstallOnce(workspaceRoot: string): Promise<{ ok: boolean; output: string; code: number | null; failureReason?: string }> {
		return new Promise((resolve) => {
			// Workspace model: no --ignore-workspace (the root workspace file
			// claims apps/*), no --no-lockfile (the root lockfile is the
			// honest record of what the workspace resolves).
			// --prefer-offline: resolve from the store when a range is already
			// satisfied, so one slow registry response cannot stall installs.
			const proc = spawn('pnpm', ['install', '--prefer-offline'], {
				cwd: workspaceRoot,
				shell: process.platform === 'win32',
				// cmd.exe (console subsystem) — never allocate a visible window.
				windowsHide: true,
				env: { ...process.env, NO_COLOR: '1' },
				// POSIX: own process group so a timeout can fell the WHOLE tree.
				// pnpm forks its real work into children; a bare kill of this
				// shim leaves them alive on the shared store, and the chained
				// next-generation install then starts a SECOND pnpm on the same
				// root — the store-corrupting overlap this module forbids.
				// Windows uses taskkill /T (the install is a short-lived
				// extension-owned child — unlike the dev server, it runs
				// without a guard).
				detached: process.platform !== 'win32',
			});
			// Mirror installer output into every open panel's Console, and
			// accumulate it so a failure can NAME its cause. Line-buffered PER
			// STREAM: a chunk ending mid-line would otherwise render as a
			// partial row that only "completes" when the next chunk arrives.
			let output = '';
			let pendingOut = '';
			let pendingErr = '';
			const streamLines = (level: 'log' | 'warn', pending: string, chunk: string): string => {
				const buffered = pending + chunk;
				const lines = buffered.split(/\r?\n/);
				const rest = lines.pop() ?? '';
				if (lines.length > 0) this.consoleAllLines(level, lines.join('\n'));
				return rest;
			};
			proc.stdout?.on('data', (chunk: Buffer) => { const s = chunk.toString('utf8'); output += s; pendingOut = streamLines('log', pendingOut, s); });
			proc.stderr?.on('data', (chunk: Buffer) => { const s = chunk.toString('utf8'); output += s; pendingErr = streamLines('warn', pendingErr, s); });
			// Settle exactly once — exit, spawn-error, and the timeout race here.
			let settled = false;
			const finish = (r: { ok: boolean; output: string; code: number | null; failureReason?: string }): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(r);
			};
			// A stalled install must not wedge the single-flight memo forever —
			// bound it and surface the failure like any other install error.
			// shell:true wraps pnpm in cmd.exe on Windows, so SIGKILL fells only
			// the wrapper while pnpm keeps running — taskkill /T fells the whole
			// tree, same approach as stop(). A timeout is terminal, not a
			// transient lock, so it carries its own non-retriable reason.
			const timer = setTimeout(() => {
				// Claim the settle synchronously so the tree-kill's own 'close'
				// (a non-zero exit, no failureReason) cannot win the race and
				// leave the outcome retriable.
				if (settled) return;
				settled = true;
				// AWAIT the tree-kill before resolving: returning while the old
				// pnpm tree is still dying would let a chained install (a newer
				// generation) start a SECOND pnpm on the shared root — exactly
				// the store-corrupting overlap this module forbids.
				void (async () => {
					if (process.platform === 'win32' && proc.pid) {
						await new Promise<void>((res) => {
							const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
							killer.on('exit', () => res());
							killer.on('error', () => res());
							// Never hang the install on a wedged taskkill.
							setTimeout(res, 3000);
						});
					} else {
						// POSIX: the spawn is detached, so signal the whole GROUP
						// (negative pid). A bare proc.kill() would fell only the
						// pnpm shim and orphan its store-writing children.
						try {
							if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
							else proc.kill('SIGKILL');
						} catch { /* group already gone */ }
					}
					resolve({ ok: false, output, code: null, failureReason: 'pnpm install timed out after 10 minutes' });
				})();
			}, 10 * 60 * 1000);
			// 'close' (not 'exit'): stdio is flushed first, so extractInstallCause
			// reads the COMPLETE output — aligns with publish.ts and runRootInstall.
			proc.on('close', (code) => {
				// Flush the carried partials so a final unterminated line still shows.
				if (pendingOut.trim()) this.consoleAllLines('log', pendingOut);
				if (pendingErr.trim()) this.consoleAllLines('warn', pendingErr);
				finish({ ok: code === 0, output, code });
			});
			proc.on('error', (err) => finish({ ok: false, output, code: null, failureReason: `pnpm could not be started: ${err.message}` }));
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
	 * @param stream - Which pipe the chunk arrived on (separate line carries).
	 */
	private handleOutput(session: WatchSession, chunk: string, stream: 'stdout' | 'stderr'): void {
		// Chunks split mid-line at the pipe's whim — a marker torn across two
		// chunks would never match its regex, and a half line rendered now
		// reads as garbage until its remainder arrives. Carry the incomplete
		// trailing line PER STREAM (stdout and stderr interleave; one shared
		// carry spliced fragments across streams) and only emit/parse
		// COMPLETE lines.
		const key = stream === 'stdout' ? 'pendingOut' : 'pendingErr';
		const buffered = (session[key] ?? '') + chunk;
		const lines = buffered.split(/\r?\n/);
		session[key] = lines.pop() ?? '';
		if (lines.length === 0) return;
		const text = lines.join('\n');

		// Mirror the raw rsbuild output into the panel Console pane — stderr
		// keeps its severity so the pane renders one stream consistently
		// with the exit-time flush (which writes carried partials as warn).
		this.consoleLines(session.app.id, stream === 'stderr' ? 'warn' : 'log', text);

		// Dev origin: "  ➜ Local:    http://localhost:3013/" (rsbuild banner)
		if (!session.devOrigin) {
			const m = /Local:\s+(http:\/\/[\w.-]+:\d+)/.exec(text);
			if (m) {
				session.devOrigin = m[1];
				this.logger.output(`[appdev] ${session.app.id} dev server at ${session.devOrigin}`);
				this.resolveReadiness(session.app.id, session.devOrigin);
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

	/**
	 * Points the caller's dev overlay at the served remoteEntry.js.
	 *
	 * The URL carries the same per-registration cache buster notifyDevEntry
	 * uses: browser shells resolve the overlay to this URL verbatim, and a
	 * constant URL let the browser serve its disk-cached container from a
	 * previous (possibly dead) server until a hard refresh — the same
	 * stale-bundle bug, on the overlay path.
	 */
	private async registerOverlay(session: WatchSession): Promise<void> {
		if (!session.devOrigin) return;
		try {
			const client = this.connectionManager.getClient();
			if (!client || !this.connectionManager.isConnected()) return;
			// Manifest basics ride along so a never-published app's desktop
			// tile renders like a store tile (real name/icon/description)
			// instead of a bare app id.
			if (session.iconUri === undefined) {
				session.iconUri = (await appIconDataUri(session.app.icon)) ?? '';
			}
			await client.call('rrext_deploy_app', {
				subcommand: 'register_dev',
				moduleId: session.app.moduleId,
				url: `${session.devOrigin}/remoteEntry.js?t=${Date.now()}`,
				appId: session.app.id,
				// This host's overlay entry is keyed to its session nonce, so
				// previews launched from THIS editor resolve THIS dev server
				// even when another editor serves the same app.
				session: DEV_SESSION_NONCE,
				name: session.app.name,
				description: session.app.description ?? '',
				appVersion: session.app.version ?? '',
				icon: session.iconUri,
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
	// HAND-ROLLED resolution, never require.resolve: inside the esbuild-
	// bundled extension the bundler's require shim cannot do real
	// filesystem resolution, so the resolve always threw and silently
	// forced EVERY dev server onto the pnpm-exec fallback — a
	// guard->cmd->pnpm->cmd->rsbuild chain whose depth is exactly what let
	// kills leak orphans on Windows (no parent-death cascade there). The
	// walk mirrors Node's own: the app's node_modules first, then hoisted
	// parents up the tree.
	let current = appRoot;
	for (let hop = 0; hop < 6; hop++) {
		const candidate = path.join(current, 'node_modules', '@rsbuild', 'core', 'bin', 'rsbuild.js');
		if (existsSync(candidate)) {
			return { cmd: process.execPath, args: [candidate], shell: false };
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// --ignore-workspace keeps the exec scoped to the app folder — inside
	// an enclosing pnpm workspace a bare exec goes recursive across ITS
	// projects (ERR_PNPM_RECURSIVE_EXEC) instead of running the app's bin.
	return { cmd: 'pnpm', args: ['--ignore-workspace', 'exec', 'rsbuild'], shell: process.platform === 'win32' };
}

/** Module-level accessor wiring (set once in extension activation). */
let instance: WatchManager | null = null;

/**
 * Installs the singleton WatchManager (called from extension activation).
 *
 * @param appScreen - The App Builder panel provider (status/console sink).
 * @param guardPath - Absolute path to the shipped devServerGuard.cjs.
 */
export function initWatchManager(appScreen: AppScreenProvider, guardPath: string): WatchManager {
	instance = new WatchManager(appScreen, guardPath);
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
