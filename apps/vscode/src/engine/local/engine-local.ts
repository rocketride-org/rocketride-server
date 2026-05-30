// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-local.ts — Local engine backend.
 *
 * Downloads the engine from GitHub (via EngineInstaller), spawns it as a
 * child process, and monitors stdout for the Uvicorn ready message to
 * extract the dynamically assigned port.
 *
 * Each VS Code window gets its own engine process on a unique port (--port=0).
 * PID files track running engines so stale processes can be detected.
 *
 * Lifecycle:
 *   install()  → download engine binary from GitHub
 *   start()    → install (if needed) + spawn subprocess → emit 'ready' with URI
 *   stop()     → graceful shutdown (close stdin → SIGTERM → 5s SIGKILL fallback)
 *   remove()   → stop + delete engine directory
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { EngineBackend, type StatusEmitter, type EngineInfo, type EngineBackendStatus, type IoControlResult, type IoProgressCallback } from '../engine-backend';
import type { ConnectionMode } from '../../config';
import { getUserConfigDir } from '../config/config-migration';
import { EngineInstaller } from '../shared/engine-installer';
import type { ConnectionGroupConfig } from '../../config';
import { getLogger } from '../../shared/util/output';
import { icons } from '../../shared/util/icons';

// =============================================================================
// LOCAL ENGINE BACKEND
// =============================================================================

export class EngineLocal extends EngineBackend {
	private readonly installer: EngineInstaller;
	private readonly logger = getLogger();

	/** The spawned engine child process. */
	private child?: ChildProcess;

	/** The dynamically assigned port parsed from Uvicorn output. */
	private actualPort?: number;

	/** Path to the PID file for this process (for stale detection). */
	private pidFilePath?: string;

	/** True while stopProcess() is in progress — suppresses spurious error events from the exit handler. */
	private stopping = false;

	/** Local-node symlinks created under <engineDir>/nodes/src/nodes/ for this run; removed on stop. */
	private linkedNodes: string[] = [];

	/**
	 * @param parentDir - Parent directory for the engine/ subdirectory.
	 *   Engine binaries live at <parentDir>/engine/engine(.exe).
	 * @param emitStatus - Callback to emit status events to EngineManager.
	 */
	constructor(parentDir: string, emitStatus: StatusEmitter) {
		super(emitStatus);
		this.installer = new EngineInstaller(parentDir, 'version.local.json');
	}

	// =========================================================================
	// PUBLIC API
	// =========================================================================

	/** The EngineInstaller (for version fetching in UI). */
	getInstaller(): EngineInstaller {
		return this.installer;
	}

	/** The port the engine is listening on (after start). */
	getActualPort(): number | undefined {
		return this.actualPort;
	}

	/** Returns installed engine version info, or null. */
	getInfo(): EngineInfo | null {
		const installed = this.installer.getInstalledVersion();
		if (!installed) return null;
		return { version: installed.tag, publishedAt: installed.publishedAt };
	}

	// =========================================================================
	// LIFECYCLE — install, start, stop, remove
	// =========================================================================

	/**
	 * Downloads/installs the engine binary. Does NOT start it.
	 * Emits progress events during download.
	 */
	async install(versionSpec: string, _config: ConnectionGroupConfig, token?: vscode.CancellationToken): Promise<void> {
		this.emitStatus({ phase: 'working', message: 'Checking for updates...' });

		const githubToken = await this.getGitHubToken();
		const progress = this.makeProgressReporter();

		try {
			await this.installer.install(versionSpec, progress, token, githubToken);
		} catch (error: unknown) {
			if (error instanceof vscode.CancellationError) throw error;

			// Rate limit: prompt for GitHub sign-in and retry once
			const msg = error instanceof Error ? error.message : String(error);
			if (!githubToken && msg.toLowerCase().includes('rate limit')) {
				const retryToken = await this.promptGitHubSignIn();
				if (retryToken) {
					await this.installer.install(versionSpec, progress, token, retryToken);
				} else {
					throw new Error('GitHub API rate limit exceeded. Sign into GitHub to increase the limit.');
				}
			} else {
				throw error;
			}
		}

		const installed = this.installer.getInstalledVersion();
		this.emitStatus({ phase: 'idle', message: 'Engine installed', version: installed?.tag });
	}

	/**
	 * Installs the engine (if needed) and starts it as a subprocess.
	 * Emits 'ready' with the URI when the engine is accepting connections.
	 */
	async start(config: ConnectionGroupConfig, token?: vscode.CancellationToken): Promise<void> {
		const versionSpec = config.local.engineVersion || 'latest';

		// --- Phase 1: Download/Install ---
		await this.install(versionSpec, config, token);

		// --- Phase 2: Start process ---
		this.emitStatus({ phase: 'working', message: 'Starting server...' });
		this.logger.output(`${icons.launch} Starting local server (dynamic port)`);

		// Stop any existing process before starting a new one
		if (this.child) {
			await this.stopProcess();
		}

		// Build engine args from config — passed as a single string intentionally.
		// The engine server handles OS-appropriate argument parsing on its side.
		// DO NOT split/tokenize rawArgs into separate argv entries here.
		const rawArgs = String(config.local.engineArgs || '').trim();
		const effectiveArgs: string[] = [];
		if (rawArgs) effectiveArgs.push(rawArgs);
		if (config.local.debugOutput && !rawArgs.includes('--trace=')) {
			effectiveArgs.push('--trace=debugOut');
		}

		const executablePath = this.installer.getExecutablePath();
		const args = [
			'--autoterm',        // Exit when VS Code closes (stdin monitoring)
			'./ai/eaas.py',
			'--host=localhost',
			'--port=0',          // Dynamic port assignment
			...effectiveArgs,
		];

		// Wipe links from any prior start() attempt on this same backend so
		// nodes removed from the workspace don't linger and so a retry can't
		// accumulate duplicates in linkedNodes.
		this.cleanupLocalNodes();
		this.setupLocalNodes(path.dirname(executablePath));

		try {
			await this.spawnProcess(executablePath, args);
		} catch (err) {
			// Spawn failed — roll back the symlinks we just created so a
			// failed start doesn't leak workspace-local links into the install.
			this.cleanupLocalNodes();
			throw err;
		}
		this.logger.output(`${icons.success} Local server started on port ${this.actualPort}`);

		const installed = this.installer.getInstalledVersion();
		this.emitStatus({
			phase: 'ready',
			message: 'Local engine ready',
			uri: `http://localhost:${this.actualPort}`,
			version: installed?.tag,
		});
	}

	/**
	 * Stops the engine subprocess gracefully.
	 */
	async stop(): Promise<void> {
		this.emitStatus({ phase: 'working', message: 'Stopping server...' });
		await this.stopProcess();
		this.cleanupLocalNodes();
		this.emitStatus({ phase: 'idle', message: 'Server stopped' });
	}

	/**
	 * Stops the engine and removes the engine directory.
	 */
	async remove(): Promise<void> {
		await this.stop();
		await this.installer.uninstall();
		this.emitStatus({ phase: 'idle', message: 'Engine removed' });
	}

	/** Re-emits the current status (ready with URI, or idle). */
	emitCurrentStatus(): void {
		if (this.child && this.actualPort) {
			const installed = this.installer.getInstalledVersion();
			this.emitStatus({
				phase: 'ready',
				message: 'Local engine ready',
				uri: `http://localhost:${this.actualPort}`,
				version: installed?.tag,
			});
		} else {
			this.emitStatus({ phase: 'idle', message: 'Not running' });
		}
	}

	// =========================================================================
	// STATIC STATUS — checks filesystem without needing an instance
	// =========================================================================

	/**
	 * Checks if a local engine is installed and whether a process is running.
	 * @param parentDir - The per-user config directory containing engine/.
	 */
	static async getStatus(parentDir: string): Promise<EngineBackendStatus> {
		const installer = new EngineInstaller(parentDir, 'version.local.json');
		const installed = installer.getInstalledVersion();
		const exePath = installer.getExecutablePath();
		const isInstalled = fs.existsSync(exePath);

		if (!isInstalled) {
			return { state: 'not-installed', version: null, publishedAt: null, installPath: null };
		}

		// Check for running engine via PID files in the engine directory
		const engineDir = installer.dir;
		let running = false;
		try {
			for (const file of fs.readdirSync(engineDir)) {
				if (file.startsWith('engine-') && file.endsWith('.pid')) {
					const pidStr = fs.readFileSync(path.join(engineDir, file), 'utf8').trim();
					const pid = parseInt(pidStr, 10);
					if (!isNaN(pid)) {
						try { process.kill(pid, 0); running = true; break; } catch { /* not running */ }
					}
				}
			}
		} catch { /* can't read dir */ }

		return {
			state: running ? 'running' : 'stopped',
			version: installed?.tag ?? null,
			publishedAt: installed?.publishedAt ?? null,
			installPath: engineDir,
		};
	}

	/**
	 * Cleans up resources — kills process, cancels nothing else.
	 */
	async dispose(): Promise<void> {
		if (this.child) await this.stopProcess();
		this.cleanupLocalNodes();
	}

	// =========================================================================
	// STATIC ioControl — panel commands
	// =========================================================================

	/**
	 * Local engine: explicit install (download binary without starting).
	 */
	static async ioControl(_mode: ConnectionMode, command: string, params?: Record<string, unknown>, onProgress?: IoProgressCallback): Promise<IoControlResult> {
		try {
			switch (command) {
				case 'install': {
					const parentDir = getUserConfigDir();
					const installer = new EngineInstaller(parentDir, 'version.local.json');
					const version = (params?.version as string) || 'latest';
					const githubToken = params?.githubToken as string | undefined;
					await installer.install(version, undefined, undefined, githubToken);
					return { success: true, data: { version: installer.getInstalledVersion()?.tag } };
				}
				default:
					return { success: false, error: `Unknown command: ${command}` };
			}
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	// =========================================================================
	// PROCESS MANAGEMENT — spawn, stop, PID tracking
	// =========================================================================

	/**
	 * Spawns the engine process and waits for the "Uvicorn running" ready
	 * message. Parses the dynamically assigned port from Uvicorn's output.
	 *
	 * Writes a PID file (engine-<pid>.pid) for stale process detection.
	 */
	private spawnProcess(executablePath: string, args: string[]): Promise<void> {
		this.logger.output(`${icons.launch} Spawning: ${executablePath} ${args.join(' ')}`);

		return new Promise((resolve, reject) => {
			const child = spawn(executablePath, args, {
				cwd: path.dirname(executablePath),
				stdio: 'pipe',
			});
			this.child = child;

			let processReady = false;
			let processErrored = false;

			// Write PID file — captured in local so async handlers remove their own file
			const myPidFile = child.pid
				? path.join(path.dirname(executablePath), `engine-${child.pid}.pid`)
				: undefined;

			if (myPidFile) {
				this.pidFilePath = myPidFile;
				try { fs.writeFileSync(myPidFile, String(child.pid)); } catch { /* non-fatal */ }
			}

			// --- Error handling ---
			child.on('error', (err) => {
				if (!processReady && !processErrored) {
					processErrored = true;
					this.logger.output(`${icons.error} Engine failed to launch: ${err.message}`);
					this.cleanupProcess(myPidFile);
					reject(err);
				}
			});

			child.on('exit', (code, signal) => {
				this.removePidFile(myPidFile);

				if (!processReady && !processErrored) {
					// Exited during startup — treat as error
					processErrored = true;
					this.logger.output(`${icons.error} Engine exited during startup (code=${code}, signal=${signal})`);
					if (this.child === child) this.cleanupProcess();
					reject(new Error(`Process exited during startup: code=${code}, signal=${signal}`));
					return;
				}

				// Exit after startup — only emit error if this wasn't an intentional stop
				if (this.child === child) {
					this.child = undefined;
				}
				if (!this.stopping) {
					this.logger.output(`${icons.stop} Engine exited unexpectedly (code=${code}, signal=${signal})`);
					this.emitStatus({ phase: 'error', message: `Engine exited (code=${code})`, error: `Process exited: code=${code}, signal=${signal}` });
				}
			});

			// --- Port extraction from Uvicorn output ---
			const portRegex = /Uvicorn running on https?:\/\/[\w.]+:(\d+)/;

			const tryResolveReady = (msg: string): void => {
				if (!processReady && !processErrored) {
					const match = msg.match(portRegex);
					if (match) {
						this.actualPort = parseInt(match[1], 10);
						processReady = true;
							this.logger.output(`${icons.success} Engine ready (port ${this.actualPort})`);
						resolve();
					}
				}
			};

			// Monitor stdout and stderr for the readiness message
			const handleOutput = (data: Buffer): void => {
				for (const line of data.toString().split('\n')) {
					const msg = line.trim();
					if (msg) {
						this.logger.console(msg);
						if (msg.includes('Uvicorn running')) tryResolveReady(msg);
					}
				}
			};
			child.stdout?.on('data', handleOutput);
			child.stderr?.on('data', handleOutput);
		});
	}

	/**
	 * Stops the engine process gracefully:
	 *   1. Close stdin (triggers --autoterm exit)
	 *   2. Send SIGTERM
	 *   3. After 5 seconds, force SIGKILL
	 */
	private stopProcess(): Promise<void> {
		this.logger.output(`${icons.stop} Stopping engine...`);
		if (!this.child) return Promise.resolve();

		this.stopping = true;
		const child = this.child;
		const pidFileToRemove = this.pidFilePath;
		this.child = undefined;
		this.actualPort = undefined;

		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (!child.killed) child.kill('SIGKILL');
			}, 5000);

			child.once('exit', () => {
				clearTimeout(timeout);
				this.stopping = false;
				this.removePidFile(pidFileToRemove);
				resolve();
			});

			// Close stdin so engine with --autoterm exits gracefully
			if (child.stdin && !child.killed) child.stdin.end();
			if (!child.killed) child.kill();
		});
	}

	/** Kills the process immediately and cleans up state. */
	private cleanupProcess(pidFile?: string): void {
		this.actualPort = undefined;
		if (this.child && !this.child.killed) this.child.kill();
		this.child = undefined;
		this.removePidFile(pidFile);
	}

	/** Removes a PID file only if it still belongs to the current process. */
	private removePidFile(expectedPath?: string): void {
		if (!this.pidFilePath) return;
		if (expectedPath && this.pidFilePath !== expectedPath) return;
		try { fs.unlinkSync(this.pidFilePath); } catch { /* already gone */ }
		this.pidFilePath = undefined;
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	/** Gets existing GitHub session token (no prompt). */
	private async getGitHubToken(): Promise<string | undefined> {
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			return session?.accessToken;
		} catch {
			return undefined;
		}
	}

	/** Prompts user to sign into GitHub and returns the token. */
	private async promptGitHubSignIn(): Promise<string | undefined> {
		this.logger.output(`${icons.info} Requesting GitHub sign-in to avoid rate limits...`);
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: true });
			return session?.accessToken;
		} catch {
			return undefined;
		}
	}

	/** Wraps emitStatus into the vscode.Progress interface that EngineInstaller expects. */
	private makeProgressReporter(): vscode.Progress<{ message?: string }> {
		return {
			report: (value) => {
				if (value.message) {
					this.emitStatus({ phase: 'working', message: value.message });
				}
			},
		};
	}

	// =========================================================================
	// LOCAL NODES — workspace-adjacent nodes/ folder symlinked into the
	// engine catalog so devs can prototype without touching the installed
	// engine. The installed engine scans <engineDir>/nodes/<node>/; we
	// mirror each <workspace>/nodes/<node>/ in there.
	// =========================================================================

	/**
	 * Symlinks each <workspaceRoot>/nodes/<node>/ subdir (must contain a
	 * services.json) into <engineDir>/nodes/src/nodes/<node>/.
	 *
	 * Guards: workspace must be trusted; folder must exist. Built-ins are
	 * NEVER overwritten — name collisions are skipped with a warning.
	 * Stale symlinks left from prior crashed runs are detected via lstat
	 * and refreshed.
	 */
	private setupLocalNodes(engineDir: string): void {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) return;

		const localNodesDir = path.join(workspaceRoot, 'nodes');
		if (!fs.existsSync(localNodesDir)) return;

		if (!vscode.workspace.isTrusted) {
			this.logger.output(`${icons.info} Local nodes folder detected at ${localNodesDir} but workspace is not trusted; ignored`);
			return;
		}

		const targetRoot = path.join(engineDir, 'nodes');
		try {
			fs.mkdirSync(targetRoot, { recursive: true });
		} catch (err) {
			this.logger.output(`${icons.warning} Could not prepare local node target dir ${targetRoot}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(localNodesDir, { withFileTypes: true });
		} catch (err) {
			this.logger.output(`${icons.warning} Could not read ${localNodesDir}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const sourceDir = path.join(localNodesDir, entry.name);
			if (!fs.existsSync(path.join(sourceDir, 'services.json'))) continue;
			const targetDir = path.join(targetRoot, entry.name);

			let reuseExisting = false;
			try {
				const existing = fs.lstatSync(targetDir);
				if (existing.isSymbolicLink()) {
					// Engine install is shared across VS Code windows. If a symlink
					// is already there, only touch it when we can prove it's safe.
					let currentTarget: string;
					try {
						currentTarget = path.resolve(targetRoot, fs.readlinkSync(targetDir));
					} catch {
						currentTarget = '';
					}
					if (currentTarget === sourceDir) {
						// Already pointing at our source (re-running on the same workspace) — reuse.
						reuseExisting = true;
					} else if (!currentTarget || !fs.existsSync(currentTarget)) {
						// Stale link from a crashed run (target no longer exists) — refresh.
						fs.unlinkSync(targetDir);
					} else {
						// Live link pointing somewhere else — likely another VS Code window's claim.
						this.logger.output(`${icons.warning} Local node "${entry.name}" target already linked to ${currentTarget}; skipped to avoid clobbering another window`);
						continue;
					}
				} else {
					this.logger.output(`${icons.warning} Local node "${entry.name}" collides with an existing engine node; skipped`);
					continue;
				}
			} catch {
				// target does not exist — proceed to create
			}

			if (reuseExisting) {
				this.linkedNodes.push(targetDir);
				continue;
			}

			try {
				fs.symlinkSync(sourceDir, targetDir, 'dir');
				this.linkedNodes.push(targetDir);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.output(`${icons.warning} Could not link local node "${entry.name}" (${msg}); skipped. On Windows, enable Developer Mode or run VS Code as administrator.`);
			}
		}

		if (this.linkedNodes.length) {
			this.logger.output(`${icons.success} Local nodes registered (${this.linkedNodes.length}): ${this.linkedNodes.map((p) => path.basename(p)).join(', ')}`);
		}
	}

	/** Removes symlinks created by setupLocalNodes. Safe to call multiple times. */
	private cleanupLocalNodes(): void {
		for (const p of this.linkedNodes) {
			try {
				const stat = fs.lstatSync(p);
				if (stat.isSymbolicLink()) fs.unlinkSync(p);
			} catch {
				// already gone — fine
			}
		}
		this.linkedNodes = [];
	}
}
