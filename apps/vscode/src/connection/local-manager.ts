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
 * local-manager.ts - Local Engine Backend Manager
 *
 * Composes EngineManager (engine install/spawn/kill) and owns the full
 * connect/disconnect lifecycle for local mode:
 *
 *   connect    → install engine if needed → start if not running → connect client with retries
 *   disconnect → disconnect client → stop engine if running
 */

import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { BaseManager, ManagerInfo } from './base-manager';
import { EngineManager } from './engine-manager';
import { ConfigManagerInfo } from '../config';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

// =============================================================================
// CONSTANTS
// =============================================================================

const LOCAL_AUTH = 'MYAPIKEY';
const MAX_CONNECT_ATTEMPTS = 120;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5000;

// =============================================================================
// MANAGER
// =============================================================================

export class LocalManager extends BaseManager {
	private engine: EngineManager;
	private logger = getLogger();

	constructor(enginesRoot: string) {
		super();
		this.engine = new EngineManager(enginesRoot);

		// Relay events from engine to ConnectionManager
		this.engine.on('status', (msg: string) => this.emit('status', msg));
		this.engine.on('terminated', (details: { code: number | null; signal: string | null }) => this.emit('terminated', details));
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	async connect(client: RocketRideClient, config: ConfigManagerInfo, token?: vscode.CancellationToken): Promise<void> {
		// Install engine if needed and start the process
		await this.engine.start(config, token);

		// Connect client to the local engine with retries
		const port = this.engine.getActualPort();
		if (!port) {
			throw new Error('Engine port not available after start');
		}

		const uri = `http://localhost:${port}`;
		let attempts = 0;

		while (attempts < MAX_CONNECT_ATTEMPTS) {
			if (token?.isCancellationRequested) {
				this.logger.output(`${icons.warning} Connection cancelled by user`);
				throw new Error('Connection cancelled');
			}

			try {
				await client.connect({ uri, auth: LOCAL_AUTH, timeout: 5000 });
				return;
			} catch (error: unknown) {
				attempts++;

				if (attempts >= MAX_CONNECT_ATTEMPTS) {
					const msg = error instanceof Error ? error.message : String(error);
					this.logger.output(`${icons.error} Connection failed after ${MAX_CONNECT_ATTEMPTS} attempts: ${msg}`);
					throw new Error(`Connection failed after ${MAX_CONNECT_ATTEMPTS} attempts: ${msg}`);
				}

				const delayMs = LocalManager.getBackoffDelayMs(attempts - 1);
				const delaySec = Math.round(delayMs / 1000);
				this.logger.output(`${icons.info} Connection attempt ${attempts} failed, waiting ${delaySec}s...`);
				this.emit('status', `Waiting ${delaySec}s before next attempt`);

				// Cancellable delay
				await this.delayWithToken(delayMs, token);
			}
		}
	}

	async disconnect(client: RocketRideClient): Promise<void> {
		await client.disconnect();
		await this.engine.stop();
	}

	getInfo(): ManagerInfo | null {
		return this.engine.getInfo();
	}

	// =========================================================================
	// ENGINE ACCESS
	// =========================================================================

	/** Expose the EngineManager for installer access (e.g. getReleases). */
	getEngine(): EngineManager {
		return this.engine;
	}

	/** The port the local engine is listening on. */
	getActualPort(): number | undefined {
		return this.engine.getActualPort();
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	private static getBackoffDelayMs(attempt: number): number {
		const delay = BACKOFF_MIN_MS * Math.pow(2, attempt);
		return Math.min(delay, BACKOFF_MAX_MS);
	}

	private delayWithToken(ms: number, token?: vscode.CancellationToken): Promise<void> {
		return new Promise((resolve, reject) => {
			if (token?.isCancellationRequested) {
				return reject(new Error('Connection cancelled'));
			}

			let timeout: NodeJS.Timeout | undefined;
			let sub: vscode.Disposable | undefined;

			const cleanup = () => {
				if (timeout !== undefined) {
					clearTimeout(timeout);
					timeout = undefined;
				}
				if (sub !== undefined) {
					sub.dispose();
					sub = undefined;
				}
			};

			sub = token?.onCancellationRequested(() => {
				cleanup();
				reject(new Error('Connection cancelled'));
			});

			timeout = setTimeout(() => {
				cleanup();
				resolve();
			}, ms);
		});
	}
}
