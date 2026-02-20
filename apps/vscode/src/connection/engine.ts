// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
 * dapsrv.ts - Debug Adapter Protocol (DAP) Server Process Manager for RocketRide VS Code Extension
 */

import * as path from 'path';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

export class EngineServer extends EventEmitter {
	private static instance: EngineServer;
	private child?: ChildProcess;
	private started = false;
	private logger = getLogger();

	/**
	 * Starts the external DAP server process and waits for it to be ready.
	 * Now properly waits for the process to actually start before resolving.
	 */
	public async startServer(executablePath: string, args: string[] = []): Promise<void> {
		this.logger.output(`${icons.launch} Starting DAP server: ${executablePath} ${args.join(' ')}`);

		return new Promise((resolve, reject) => {
			// Spawn the child process
			this.child = spawn(executablePath, args, {
				cwd: path.dirname(executablePath),
				stdio: 'pipe',
			});

			let processReady = false;
			let processErrored = false;

			// Set up timeout for process startup
			const startupTimeout = setTimeout(() => {
				if (!processReady && !processErrored) {
					this.logger.output(`${icons.error} DAP server startup timeout`);
					this.cleanup();
					reject(new Error('Process startup timeout'));
				}
			}, 10000); // 10 second timeout

			// Handle process launch errors
			this.child.on('error', (err) => {
				if (!processReady && !processErrored) {
					processErrored = true;
					clearTimeout(startupTimeout);
					this.logger.output(`${icons.error} DAP server failed to launch: ${err.message}`);
					this.cleanup();
					reject(err);
				}
			});

			// Handle early process exit (startup failure)
			this.child.on('exit', (code, signal) => {
				if (!processReady && !processErrored) {
					processErrored = true;
					clearTimeout(startupTimeout);
					this.logger.output(`${icons.error} DAP server exited during startup (code=${code}, signal=${signal})`);
					this.cleanup();
					reject(new Error(`Process exited during startup: code=${code}, signal=${signal}`));
					return;
				}

				// Normal exit after successful startup
				this.logger.output(`${icons.stop} DAP server exited (code=${code}, signal=${signal})`);
				this.started = false;
				this.child = undefined;
				this.emit('terminated', { code, signal });
			});

			// Monitor stdout for startup indicators
			this.child.stdout?.on('data', (data) => {
				const output = data.toString();
				const messages = output.split('\n');

				for (const message of messages) {
					if (message.trim()) {
						this.logger.output(`${icons.message} ${message.trim()}`);

						// Look for indicators that the server is ready
						// Common patterns: "Server listening", "Started", "Ready", port binding messages
						if (!processReady && this.isServerReadyMessage(message)) {
							processReady = true;
							this.started = true;
							clearTimeout(startupTimeout);
							this.logger.output(`${icons.success} DAP server is ready`);
							resolve();
						}
					}
				}
			});

			// Monitor stderr 
			this.child.stderr?.on('data', (data) => {
				const output = data.toString();
				const messages = output.split('\n');

				for (const message of messages) {
					if (message.trim()) {
						this.logger.output(`${icons.message} ${message.trim()}`);

						// Also check stderr for ready indicators (some servers log to stderr)
						if (!processReady && this.isServerReadyMessage(message)) {
							processReady = true;
							this.started = true;
							clearTimeout(startupTimeout);
							this.logger.output(`${icons.success} DAP server is ready`);
							resolve();
						}
					}
				}
			});

			// Fallback: if we don't see a ready message, assume ready after a short delay
			// This handles servers that don't output clear ready indicators
			setTimeout(() => {
				if (!processReady && !processErrored && this.child && !this.child.killed) {
					processReady = true;
					this.started = true;
					clearTimeout(startupTimeout);
					this.logger.output(`${icons.success} DAP server assumed ready (no explicit ready message)`);
					resolve();
				}
			}, 3000); // 3 second fallback
		});
	}

	/**
	 * Check if a log message indicates the server is ready to accept connections
	 */
	private isServerReadyMessage(message: string): boolean {
		const readyIndicators = [
			'server listening',
			'server started',
			'listening on',
			'ready to accept',
			'server ready',
			'started on port',
			'listening at',
			'bound to',
			'server running',
			'accepting connections'
		];

		const lowerMessage = message.toLowerCase();
		return readyIndicators.some(indicator => lowerMessage.includes(indicator));
	}

	/**
	 * Clean up process state
	 */
	private cleanup(): void {
		this.started = false;
		if (this.child && !this.child.killed) {
			this.child.kill();
		}
		this.child = undefined;
	}

	/**
	 * Stops the external DAP server process gracefully.
	 */
	public stopServer(): void {
		this.logger.output(`${icons.stop} Stopping DAP server...`);
		this.child?.kill();
	}
}
