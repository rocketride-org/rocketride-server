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
 * engine-manager.ts - Local Engine Backend Manager
 *
 * Manages the local backend: installs the engine binary (via EngineInstaller)
 * and runs the engine child process. Each VS Code window gets its own engine
 * on a dynamically assigned port (--port=0). PID files track running engines
 * for safe cleanup of old version directories.
 *
 * Emits 'status' events for UI progress and 'terminated' when the engine
 * process dies unexpectedly.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { BaseManager, ManagerInfo } from './base-manager';
import { EngineInstaller } from './engine-installer';
import { ConfigManagerInfo } from '../config';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

export class EngineManager extends BaseManager {
	private readonly installer: EngineInstaller;
	private readonly logger = getLogger();
	private child?: ChildProcess;
	private started = false;
	private actualPort?: number;
	private pidFilePath?: string;

	constructor(enginesRoot: string) {
		super();
		this.installer = new EngineInstaller(enginesRoot);
	}

	/**
	 * Returns the EngineInstaller for direct access (e.g. getReleases() for settings UI).
	 */
	public getInstaller(): EngineInstaller {
		return this.installer;
	}

	/**
	 * Returns the actual port the engine is listening on (assigned by OS).
	 */
	public getActualPort(): number | undefined {
		return this.actualPort;
	}

	/**
	 * Installs the engine (if needed) and starts the engine process.
	 * Emits 'status' events throughout for UI display.
	 */
	public async start(config: ConfigManagerInfo, token?: vscode.CancellationToken): Promise<void> {
		// --- Phase 1: Install ---
		const versionSpec = config.local.engineVersion || 'latest';

		this.emit('status', 'Checking for updates...');

		// Use existing GitHub sign-in if present (avoids 60/hr rate limit; no prompt)
		let githubToken: string | undefined;
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			githubToken = session?.accessToken;
		} catch {
			// Proceed without token; may hit rate limit
		}

		// Wrap this.emit('status') into the vscode.Progress interface that EngineInstaller expects
		const progress: vscode.Progress<{ message?: string; increment?: number }> = {
			report: (value) => {
				if (value.message) {
					this.emit('status', value.message);
				}
			}
		};

		let executablePath: string;
		try {
			executablePath = await this.installer.install(versionSpec, progress, token, githubToken);
		} catch (error: unknown) {
			if (error instanceof vscode.CancellationError) {
				this.logger.output(`${icons.info} Engine download cancelled`);
				throw error;
			}
			const msg = error instanceof Error ? error.message : String(error);
			if (!githubToken && msg.toLowerCase().includes('rate limit')) {
				// Prompt user to sign into GitHub to get a higher rate limit
				this.logger.output(`${icons.info} Requesting GitHub sign-in to avoid rate limits...`);
				try {
					const session = await vscode.authentication.getSession('github', [], { createIfNone: true });
					if (session?.accessToken) {
						githubToken = session.accessToken;
						executablePath = await this.installer.install(versionSpec, progress, token, githubToken);
						// Fall through to start phase
					} else {
						throw new Error('GitHub API rate limit exceeded. Sign into GitHub (via Accounts menu) to increase the limit, then reconnect.');
					}
				} catch (retryError) {
					if (retryError instanceof vscode.CancellationError) {
						throw retryError;
					}
					throw new Error('GitHub API rate limit exceeded. Sign into GitHub (via Accounts menu) to increase the limit, then reconnect.');
				}
			} else {
				throw error;
			}
		}

		// --- Phase 2: Start process ---
		this.emit('status', 'Starting server...');

		this.logger.output(`${icons.launch} Starting local server (dynamic port)`);

		// Stop any existing process
		if (this.child) {
			this.removeAllListeners('terminated');
			await this.stopProcess();
		}

		// engineArgs may be a legacy string[] from old config or the new string format
		const rawArgs = config.engineArgs;
		const engineArgsStr = Array.isArray(rawArgs) ? rawArgs.join(' ') : String(rawArgs || '');

		const args = [
			'--autoterm',  // Exit when VS Code closes (stdin monitoring)
			'./ai/eaas.py',
			'--host=localhost',
			'--port=0',
			...(config.local.debugOutput
				? ['--trace=servicePython']
				: engineArgsStr.trim() ? [engineArgsStr.trim()] : [])
		];

		await this.startProcess(executablePath, args);
		this.logger.output(`${icons.success} Local server started on port ${this.actualPort}`);

		// Fire-and-forget cleanup of old version directories
		const currentDir = path.dirname(executablePath);
		this.installer.cleanupOldVersions(currentDir).catch(err => {
			this.logger.output(`${icons.warning} Failed to clean up old engines: ${err}`);
		});
	}

	/**
	 * Stops the engine process.
	 */
	public async stop(): Promise<void> {
		this.emit('status', 'Stopping server...');
		await this.stopProcess();
	}

	/**
	 * Returns installed engine version info, or null if not installed.
	 */
	public getInfo(): ManagerInfo | null {
		const version = this.installer.getInstalledVersion();
		const publishedAt = this.installer.getInstalledPublishedAt();
		if (!version) {
			return null;
		}
		return { version, publishedAt: publishedAt ?? '' };
	}

	// =========================================================================
	// Process management
	// =========================================================================

	/**
	 * Spawns the engine process and waits for the "Uvicorn running" ready message.
	 * Parses the actual port from the Uvicorn output line.
	 */
	private startProcess(executablePath: string, args: string[]): Promise<void> {
		this.logger.output(`${icons.launch} Starting DAP server: ${executablePath} ${args.join(' ')}`);

		return new Promise((resolve, reject) => {
			this.child = spawn(executablePath, args, {
				cwd: path.dirname(executablePath),
				stdio: 'pipe',
			});

			let processReady = false;
			let processErrored = false;

			// Write PID file for in-use detection by cleanup
			if (this.child.pid) {
				this.pidFilePath = path.join(path.dirname(executablePath), `engine-${this.child.pid}.pid`);
				try {
					fs.writeFileSync(this.pidFilePath, String(this.child.pid));
				} catch {
					// Non-fatal — cleanup will use OS-level checks as fallback
				}
			}

			this.child.on('error', (err) => {
				if (!processReady && !processErrored) {
					processErrored = true;
					this.logger.output(`${icons.error} DAP server failed to launch: ${err.message}`);
					this.cleanupProcess();
					reject(err);
				}
			});

			this.child.on('exit', (code, signal) => {
				// Clean up PID file on exit
				this.removePidFile();

				if (!processReady && !processErrored) {
					processErrored = true;
					this.logger.output(`${icons.error} DAP server exited during startup (code=${code}, signal=${signal})`);
					this.cleanupProcess();
					reject(new Error(`Process exited during startup: code=${code}, signal=${signal}`));
					return;
				}

				// Normal exit after successful startup
				this.logger.output(`${icons.stop} DAP server exited (code=${code}, signal=${signal})`);
				this.started = false;
				this.child = undefined;
				this.emit('terminated', { code, signal });
			});

			const portRegex = /Uvicorn running on https?:\/\/[\w.]+:(\d+)/;

			const tryResolveReady = (msg: string): void => {
				if (!processReady && !processErrored) {
					const match = msg.match(portRegex);
					if (match) {
						this.actualPort = parseInt(match[1], 10);
					}
					processReady = true;
					this.started = true;
					this.logger.output(`${icons.success} DAP server is ready (port ${this.actualPort})`);
					resolve();
				}
			};

			// Monitor stdout for readiness
			this.child.stdout?.on('data', (data) => {
				const output = data.toString();
				for (const message of output.split('\n')) {
					const msg = message.trim();
					if (msg) {
						this.logger.console(msg);
						if (msg.includes('Uvicorn running')) {
							tryResolveReady(msg);
						}
					}
				}
			});

			// Monitor stderr
			this.child.stderr?.on('data', (data) => {
				const output = data.toString();
				for (const message of output.split('\n')) {
					const msg = message.trim();
					if (msg) {
						this.logger.console(msg);
						if (msg.includes('Uvicorn running')) {
							tryResolveReady(msg);
						}
					}
				}
			});
		});
	}

	/**
	 * Stops the engine process gracefully (stdin close + kill), with a 5s SIGKILL fallback.
	 */
	private stopProcess(): Promise<void> {
		this.logger.output(`${icons.stop} Stopping DAP server...`);
		if (!this.child) {
			return Promise.resolve();
		}
		const child = this.child;
		this.started = false;
		this.child = undefined;
		this.actualPort = undefined;

		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (!child.killed) {
					child.kill('SIGKILL');
				}
				this.removePidFile();
				resolve();
			}, 5000);

			child.once('exit', () => {
				clearTimeout(timeout);
				this.removePidFile();
				resolve();
			});

			// Close stdin so engine with --autoterm exits gracefully
			if (child.stdin && !child.killed) {
				child.stdin.end();
			}
			if (!child.killed) {
				child.kill();
			}
		});
	}

	private cleanupProcess(): void {
		this.started = false;
		this.actualPort = undefined;
		if (this.child && !this.child.killed) {
			this.child.kill();
		}
		this.child = undefined;
		this.removePidFile();
	}

	private removePidFile(): void {
		if (this.pidFilePath) {
			try {
				fs.unlinkSync(this.pidFilePath);
			} catch {
				// Ignore — file may already be gone
			}
			this.pidFilePath = undefined;
		}
	}
}
