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
 * The app dev loop — `rocketride/app-dev` (Node.js only).
 *
 * `rsbuild dev` serves an app's Module Federation remote from its folder and
 * rebuilds on save. The developer's PERSONAL dev overlay
 * (`rrext_deploy_app.register_dev`) points the server's shell at that local
 * bundle — keyed by a per-host session nonce, so a preview opened with
 * `?rrsession=<nonce>` resolves THIS host's dev server even when another
 * editor serves the same app. The registration lives as long as the
 * registering connection (plus an idle TTL), so a host keeps its connection
 * open for the whole session and re-registers after every rebuild.
 *
 * The scaffolded rsbuild config runs HMR with live reload against
 * ws://localhost:<port>, so ANY page that loaded the dev bundle — the VS
 * Code panel or a plain browser tab — updates on save by itself.
 *
 * Shared by the VS Code extension's WatchManager (multi-app, panel-driven)
 * and `rocketride app dev` (one app, foreground) via the primitives below;
 * {@link DevSession} composes them for single-app terminal hosts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { appIconDataUri } from '../app-pack/scan.js';
import type { ScannedApp } from '../app-pack/scan.js';
import { isTransientLockError, runRootInstall } from '../app-pack/vendor.js';
import { materializeDevServerGuard } from './guard.js';

export { DEV_SERVER_GUARD_SOURCE, materializeDevServerGuard } from './guard.js';

// =============================================================================
// SESSION + PREVIEW URL
// =============================================================================

/** This host process's dev-session nonce (stable for the process lifetime). */
export const DEV_SESSION_NONCE = randomUUID();

/**
 * The preview URL for an app's dev bundle: the server's shell, locked to the
 * app, with dev hooks on and routed to this host's overlay entry.
 *
 * @param baseUrl - The server's web origin (http(s), no trailing slash needed).
 * @param appId - The app id.
 * @param session - The registering host's nonce (default: this process's).
 * @returns The URL to open in a browser (or an embedding panel).
 */
export function devPreviewUrl(baseUrl: string, appId: string, session: string = DEV_SESSION_NONCE): string {
	return `${baseUrl.replace(/\/+$/, '')}/?appid=${encodeURIComponent(appId)}&rrdev=1&rrsession=${encodeURIComponent(session)}`;
}

// =============================================================================
// RSBUILD
// =============================================================================

/**
 * Resolves how to invoke rsbuild for an app folder: the app-local bin first
 * (deterministic), `pnpm exec` as the fallback for hoisted trees.
 *
 * HAND-ROLLED resolution, never require.resolve: inside a bundled host the
 * bundler's require shim cannot do real filesystem resolution, which forced
 * every dev server onto the pnpm-exec fallback — a guard->cmd->pnpm->cmd->
 * rsbuild chain whose depth let kills leak orphans on Windows. The walk
 * mirrors Node's own: the app's node_modules first, then hoisted parents.
 *
 * @param appRoot - The app's absolute folder path.
 * @returns The command, its args, and whether it needs a shell.
 */
export function resolveRsbuildInvocation(appRoot: string): { cmd: string; args: string[]; shell: boolean } {
	let current = appRoot;
	for (let hop = 0; hop < 6; hop++) {
		const candidate = path.join(current, 'node_modules', '@rsbuild', 'core', 'bin', 'rsbuild.js');
		if (fs.existsSync(candidate)) {
			return { cmd: process.execPath, args: [candidate], shell: false };
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// --ignore-workspace keeps the exec scoped to the app folder — inside an
	// enclosing pnpm workspace a bare exec goes recursive across ITS projects
	// (ERR_PNPM_RECURSIVE_EXEC) instead of running the app's bin.
	return { cmd: 'pnpm', args: ['--ignore-workspace', 'exec', 'rsbuild'], shell: process.platform === 'win32' };
}

/**
 * Splits a process output chunk into COMPLETE lines. Pipes split chunks
 * mid-line, and a marker torn across two chunks never matches; callers keep
 * one carry PER STREAM (stdout and stderr interleave).
 *
 * @param pending - The incomplete line carried from the previous chunk.
 * @param chunk - The new chunk.
 * @returns The complete lines and the new carry.
 */
export function splitCompleteLines(pending: string, chunk: string): { lines: string[]; rest: string } {
	const lines = (pending + chunk).split(/\r?\n/);
	const rest = lines.pop() ?? '';
	return { lines, rest };
}

/** What a batch of rsbuild output lines announces. */
export interface DevOutputSignal {
	/** The dev server origin (http://host:port), when the banner appeared. */
	origin?: string;
	/** Build lifecycle edge, when one appeared. */
	event?: 'built' | 'failed' | 'building';
}

/**
 * Classifies complete rsbuild output lines: the dev origin from the banner
 * ("➜ Local: http://localhost:3013/"), and build completions and failures.
 * Lines tagged "[browser]" are dev.browserLogs relays of the PAGE's runtime
 * errors in rsbuild's own format — app traffic, not compiler state — and
 * never classify.
 *
 * @param lines - Complete output lines.
 * @returns The signal the lines carry.
 */
export function classifyDevOutput(lines: string[]): DevOutputSignal {
	const signal: DevOutputSignal = {};
	const origin = /Local:\s+(http:\/\/[\w.-]+:\d+)/.exec(lines.join('\n'));
	if (origin) signal.origin = origin[1];
	const compilerText = lines.filter((line) => !/^\s*\w+\s+\[browser\]/.test(line)).join('\n');
	if (/built in\s+[\d.]+/i.test(compilerText)) signal.event = 'built';
	else if (/build failed|error {3}/i.test(compilerText)) signal.event = 'failed';
	else if (/building|compiling/i.test(compilerText)) signal.event = 'building';
	return signal;
}

// =============================================================================
// SPAWN + STOP (guarded)
// =============================================================================

/**
 * Spawns `rsbuild dev` for an app under the GUARD — a liveness tether to the
 * calling process. The guard's stdin is a pipe from this process; any death
 * of the host closes it and the guard fells its own tree, so dev-server
 * orphans are structurally impossible. The guard passes rsbuild's output
 * through and mirrors its exit code.
 *
 * @param appFolder - The app's folder (the dev server's cwd).
 * @param options.guardPath - The guard script (default: the materialized SDK guard).
 * @returns The guard process (stdout/stderr carry rsbuild's output).
 */
export function spawnDevServer(appFolder: string, options: { guardPath?: string } = {}): ChildProcess {
	const invocation = resolveRsbuildInvocation(appFolder);
	return spawn(process.execPath, [options.guardPath ?? materializeDevServerGuard(), String(process.pid), invocation.shell ? '1' : '0', invocation.cmd, ...invocation.args, 'dev'], {
		cwd: appFolder,
		env: { ...process.env, NO_COLOR: '1' },
		// Never allocate a console window for the guard or its tree
		windowsHide: true,
		// POSIX: the guard leads its own process GROUP (rsbuild joins it) so
		// one group signal fells the tree; on Windows the guard kills its
		// subtree itself
		detached: process.platform !== 'win32',
	});
}

/**
 * Stops a guarded dev server. Closing the guard's stdin IS the stop verb —
 * the guard fells its own tree and releases the port. Awaited (a restart's
 * new spawn must not find the old port taken, or rsbuild silently bumps to
 * the next one and the overlay points at a zombie). Escalates to a tree
 * kill only for a guard that ignores the close.
 *
 * @param proc - The guard process from {@link spawnDevServer}.
 * @param graceMs - How long to wait for the guard before escalating.
 */
export async function stopDevServer(proc: ChildProcess, graceMs = 5000): Promise<void> {
	if (!proc.pid) {
		proc.kill();
		return;
	}
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	const exited = new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true)));
	try {
		proc.stdin?.destroy();
	} catch {
		// pipe already closed — the guard is reacting
	}
	const finished = await Promise.race([exited, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs))]);
	if (finished) return;
	const pid = proc.pid;
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
		} catch {
			// group already gone
		}
	}
}

// =============================================================================
// DEV OVERLAY
// =============================================================================

/** The client surface the overlay calls need. */
export interface DevOverlayClient {
	call(command: string, args: Record<string, unknown>): Promise<unknown>;
}

/** What one overlay registration announces. */
export interface DevOverlayEntry {
	/** MF container name (app id with dots/hyphens as underscores). */
	moduleId: string;
	/** The app id. */
	appId: string;
	/** The dev server origin (http://localhost:<port>). */
	origin: string;
	/** Display name, description, version, and icon data: URI — so a
	    never-published app's desktop tile renders like a store tile. */
	name?: string;
	description?: string;
	appVersion?: string;
	icon?: string;
	/** The registering host's nonce (default: this process's). */
	session?: string;
}

/**
 * Points the caller's dev overlay at a dev server's remoteEntry.js. The URL
 * carries a per-registration cache buster: shells resolve the overlay to it
 * verbatim, and a constant URL let the browser serve a disk-cached container
 * from a previous (possibly dead) server until a hard refresh.
 *
 * @param client - A connected client.
 * @param entry - The registration.
 */
export async function registerDevOverlay(client: DevOverlayClient, entry: DevOverlayEntry): Promise<void> {
	await client.call('rrext_deploy_app', {
		subcommand: 'register_dev',
		moduleId: entry.moduleId,
		url: `${entry.origin}/remoteEntry.js?t=${Date.now()}`,
		appId: entry.appId,
		session: entry.session ?? DEV_SESSION_NONCE,
		name: entry.name ?? '',
		description: entry.description ?? '',
		appVersion: entry.appVersion ?? '',
		icon: entry.icon ?? '',
	});
}

/**
 * Drops the caller's dev overlay entry so shells return to the published
 * bundle.
 *
 * @param client - A connected client.
 * @param moduleId - The app's MF container name.
 */
export async function unregisterDevOverlay(client: DevOverlayClient, moduleId: string): Promise<void> {
	await client.call('rrext_deploy_app', { subcommand: 'register_dev', moduleId, unregister: true });
}

// =============================================================================
// SINGLE-APP SESSION (terminal hosts)
// =============================================================================

/** A dev session's state, for status lines. */
export type DevState = 'installing' | 'starting' | 'building' | 'ok' | 'error' | 'stopped';

/** Host callbacks for a {@link DevSession}. */
export interface DevSessionHooks {
	/** One line of install or dev-server output. */
	onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
	/** A state change, with the build time on 'ok' and a reason on 'error'. */
	onState?: (state: DevState, detail?: { origin?: string; durationMs?: number; reason?: string }) => void;
}

/** Options for a {@link DevSession}. */
export interface DevSessionOptions extends DevSessionHooks {
	/** The app to serve. */
	app: ScannedApp;
	/** The workspace root (where `pnpm install` runs). */
	workspaceRoot: string;
	/** A connected client for the overlay registration. */
	client: DevOverlayClient;
	/** Run the workspace install before starting (default true). */
	install?: boolean;
	/** Restart the server when the app's package.json changes (default true). */
	watchPackageJson?: boolean;
}

/** A death inside this window after start counts toward the crash-loop guard. */
const RESPAWN_WINDOW_MS = 30_000;
/** Auto-respawns allowed per quick-death streak before giving up. */
const MAX_RESPAWNS = 3;
/** Install attempts on a transient Windows file lock. */
const MAX_INSTALL_ATTEMPTS = 3;

/**
 * One app's dev loop for a foreground host (`rocketride app dev`): install,
 * spawn the guarded dev server, register the overlay on the first build and
 * after every rebuild, respawn a crashed server (bounded), restart on a
 * package.json edit, and on stop kill the tree and unregister.
 */
export class DevSession {
	private proc: ChildProcess | null = null;
	private origin = '';
	private buildStart: number | undefined;
	private startedAt = 0;
	private strikes = 0;
	private stopping = false;
	private iconUri: string | undefined;
	private pkgWatcher: fs.FSWatcher | null = null;
	private pkgTimer: NodeJS.Timeout | undefined;
	private restarts: Promise<void> = Promise.resolve();
	private restartQueued = false;
	private readiness: { resolve: (origin: string) => void; reject: (err: Error) => void } | null = null;

	/**
	 * @param options - See {@link DevSessionOptions}.
	 */
	constructor(private readonly options: DevSessionOptions) {}

	/** The dev server origin once serving ('' before). */
	get devOrigin(): string {
		return this.origin;
	}

	/**
	 * Installs (unless disabled), spawns the dev server, and resolves with its
	 * origin once it is serving. Rejects when the install or the spawn fails.
	 *
	 * @returns The dev server origin (http://localhost:<port>).
	 */
	async start(): Promise<string> {
		this.stopping = false;
		if (this.options.install !== false) await this.install();
		const ready = new Promise<string>((resolve, reject) => {
			this.readiness = { resolve, reject };
		});
		this.spawn();
		if (this.options.watchPackageJson !== false) this.watchPackageJson();
		return ready;
	}

	/**
	 * Re-announces the running server — call after the host reconnects (the
	 * overlay registration expires with the connection that made it).
	 */
	async reregister(): Promise<void> {
		if (this.origin) await this.register();
	}

	/** Stops the server (tree kill) and drops the overlay entry. */
	async stop(): Promise<void> {
		this.stopping = true;
		if (this.pkgTimer) clearTimeout(this.pkgTimer);
		this.pkgWatcher?.close();
		this.pkgWatcher = null;
		// a restart in flight may be stopping the old server; let it finish
		// (it will not spawn again once `stopping` is set)
		await this.restarts;
		const proc = this.proc;
		this.proc = null;
		if (proc) await stopDevServer(proc);
		this.readiness?.reject(new Error('dev session stopped'));
		this.readiness = null;
		try {
			await unregisterDevOverlay(this.options.client, this.options.app.moduleId);
		} catch {
			// connection gone — the overlay's disconnect expiry covers it
		}
		this.origin = '';
		this.options.onState?.('stopped');
	}

	/** Runs the workspace install, retrying a transient Windows file lock. */
	private async install(): Promise<void> {
		this.options.onState?.('installing');
		for (let attempt = 1; ; attempt++) {
			try {
				await runRootInstall(this.options.workspaceRoot);
				return;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (attempt >= MAX_INSTALL_ATTEMPTS || !isTransientLockError(message)) {
					this.options.onState?.('error', { reason: message });
					throw err;
				}
				this.options.onLine?.(`pnpm install hit a transient file lock — retrying (attempt ${attempt + 1}/${MAX_INSTALL_ATTEMPTS})`, 'stderr');
				await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
			}
		}
	}

	/** Spawns the guarded dev server and wires its output and exit. */
	private spawn(): void {
		const proc = spawnDevServer(this.options.app.folder);
		this.proc = proc;
		this.startedAt = Date.now();
		this.buildStart = Date.now();
		this.options.onState?.('starting');

		const carry = { stdout: '', stderr: '' };
		const onChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
			const { lines, rest } = splitCompleteLines(carry[stream], chunk.toString('utf8'));
			carry[stream] = rest;
			if (lines.length > 0) this.handleLines(lines, stream);
		};
		proc.stdout?.on('data', onChunk('stdout'));
		proc.stderr?.on('data', onChunk('stderr'));

		proc.on('exit', (code) => {
			// Intentional stops clear `proc` first, so an exit that still owns
			// it is a CRASH
			if (this.proc !== proc || this.stopping) return;
			this.proc = null;
			this.origin = '';
			for (const stream of ['stdout', 'stderr'] as const) {
				if (carry[stream].trim()) this.options.onLine?.(carry[stream], stream);
			}
			const quickDeath = Date.now() - this.startedAt < RESPAWN_WINDOW_MS;
			this.strikes = quickDeath ? this.strikes + 1 : 1;
			if (this.strikes <= MAX_RESPAWNS) {
				this.options.onLine?.(`dev server exited (${code}) — respawning (attempt ${this.strikes}/${MAX_RESPAWNS})`, 'stderr');
				this.spawn();
				return;
			}
			const reason = `the dev server exited ${this.strikes} times in a row`;
			this.readiness?.reject(new Error(reason));
			this.readiness = null;
			this.options.onState?.('error', { reason });
		});
		proc.on('error', (err) => {
			if (this.proc !== proc) return;
			this.proc = null;
			this.readiness?.reject(err);
			this.readiness = null;
			this.options.onState?.('error', { reason: err.message });
		});
	}

	/** Mirrors output lines and acts on what they announce. */
	private handleLines(lines: string[], stream: 'stdout' | 'stderr'): void {
		for (const line of lines) {
			if (line.trim()) this.options.onLine?.(line, stream);
		}
		const signal = classifyDevOutput(lines);
		if (signal.origin && !this.origin) {
			this.origin = signal.origin;
			this.readiness?.resolve(this.origin);
			this.readiness = null;
			void this.register();
		}
		if (signal.event === 'built') {
			const durationMs = this.buildStart ? Date.now() - this.buildStart : undefined;
			this.buildStart = undefined;
			this.options.onState?.('ok', { origin: this.origin, durationMs });
			// Re-register after every rebuild: a fresh cache-busted entry, and
			// it keeps the overlay's idle TTL alive
			void this.register();
		} else if (signal.event === 'failed') {
			this.buildStart = undefined;
			this.options.onState?.('error', { origin: this.origin, reason: 'the app failed to compile (see the output above)' });
		} else if (signal.event === 'building' && this.buildStart === undefined) {
			this.buildStart = Date.now();
			this.options.onState?.('building', { origin: this.origin });
		}
	}

	/** Points the overlay at the running server (failures are reported, not thrown). */
	private async register(): Promise<void> {
		if (!this.origin) return;
		const app = this.options.app;
		try {
			if (this.iconUri === undefined) this.iconUri = (await appIconDataUri(app.icon)) ?? '';
			await registerDevOverlay(this.options.client, {
				moduleId: app.moduleId,
				appId: app.id,
				origin: this.origin,
				name: app.name,
				description: app.description,
				appVersion: app.version,
				icon: this.iconUri,
			});
		} catch (err) {
			this.options.onLine?.(`register_dev failed: ${err instanceof Error ? err.message : String(err)}`, 'stderr');
		}
	}

	/**
	 * Restarts (reinstall + respawn) when the app's package.json changes.
	 * Watches the folder, not the file: an editor's atomic save renames a new
	 * file over package.json, and a file watch stays on the replaced inode.
	 */
	private watchPackageJson(): void {
		try {
			this.pkgWatcher = fs.watch(this.options.app.folder, (_event, filename) => {
				if (filename?.toString() !== 'package.json') return;
				if (this.pkgTimer) clearTimeout(this.pkgTimer);
				this.pkgTimer = setTimeout(() => this.requestRestart(), 800);
			});
		} catch {
			// no watcher on this platform/filesystem — edits need a manual restart
		}
	}

	/**
	 * Queues a restart behind any in flight, so two never overlap (both would
	 * spawn, and the first server would outlive stop()). Requests made while
	 * one is already queued fold into it.
	 */
	private requestRestart(): void {
		if (this.restartQueued) return;
		this.restartQueued = true;
		this.restarts = this.restarts.then(() => {
			this.restartQueued = false;
			return this.restart();
		});
	}

	/** Stops the server, reinstalls, and starts it again. */
	private async restart(): Promise<void> {
		if (this.stopping) return;
		this.options.onLine?.('package.json changed — reinstalling and restarting the dev server', 'stdout');
		const proc = this.proc;
		this.proc = null;
		this.origin = '';
		if (proc) await stopDevServer(proc);
		if (this.stopping) return;
		this.strikes = 0;
		try {
			if (this.options.install !== false) await this.install();
			if (!this.stopping) this.spawn();
		} catch {
			// install failure already reported through onState
		}
	}
}
