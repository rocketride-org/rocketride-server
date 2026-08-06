// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-onprem.ts — On-premises engine backend.
 *
 * On-prem mode has no engine to manage locally — the server runs on the
 * user's own infrastructure. This backend validates the host URL and
 * resolves the connection URI.
 *
 * Authentication uses a user-provided API key (handled by ConnectionManager).
 */

import * as vscode from 'vscode';
import { EngineBackend, type StatusEmitter, type EngineInfo, type EngineBackendStatus, type IoControlResult, type IoProgressCallback } from '../engine-backend';
import type { ConnectionMode } from '../../config';
import type { ConnectionGroupConfig } from '../../config';

// =============================================================================
// ON-PREM ENGINE BACKEND
// =============================================================================

export class EngineOnprem extends EngineBackend {
	/** The on-prem server URL (set after a successful start). */
	private hostUrl?: string;

	/**
	 * @param emitStatus - Callback to emit status events to EngineManager.
	 */
	constructor(emitStatus: StatusEmitter) {
		super(emitStatus);
	}

	/**
	 * Validates the on-prem host URL and emits 'ready' with the URI.
	 * API key validation is handled by ConnectionManager (not here).
	 */
	async start(config: ConnectionGroupConfig, _token?: vscode.CancellationToken): Promise<void> {
		if (!config.hostUrl) {
			this.hostUrl = undefined;
			this.emitStatus({ phase: 'error', message: 'Host URL not configured', error: 'Host URL is required for on-prem connections' });
			return;
		}

		this.hostUrl = config.hostUrl;
		this.emitStatus({
			phase: 'ready',
			message: 'On-prem server ready',
			uri: this.hostUrl,
		});
	}

	/** No process to stop in on-prem mode. */
	async stop(): Promise<void> {
		this.hostUrl = undefined;
		this.emitStatus({ phase: 'idle', message: 'Disconnected from on-prem' });
	}

	/** No local engine info in on-prem mode. */
	getInfo(): EngineInfo | null {
		return null;
	}

	/** Re-emits the current status. */
	emitCurrentStatus(): void {
		if (this.hostUrl) {
			this.emitStatus({ phase: 'ready', message: 'On-prem server ready', uri: this.hostUrl });
		} else {
			this.emitStatus({ phase: 'idle', message: 'Not configured' });
		}
	}

	/** Nothing to dispose. */
	async dispose(): Promise<void> {}

	/**
	 * Returns status based on whether a host URL is configured.
	 * Does NOT probe the server — that's triggered by the "Test Connection"
	 * button in the on-prem panel (handled by ConnectionMessageHandler).
	 */
	static async getStatus(hostUrl?: string): Promise<EngineBackendStatus> {
		// We can't know if it's running without probing — just report whether it's configured
		return {
			state: hostUrl ? 'running' : 'not-installed',
			version: null,
			publishedAt: null,
			installPath: null,
		};
	}

	// =========================================================================
	// STATIC ioControl — on-prem commands
	// =========================================================================

	/**
	 * Handles on-prem panel commands ('test' — connection test via SDK).
	 * Creates a temporary RocketRideClient to verify the server is reachable.
	 *
	 * @param _mode - Connection mode (unused, always 'onprem').
	 * @param command - The command to execute: 'test'.
	 * @param params - Must include `hostUrl`; optionally `apiKey`.
	 * @returns Result with success flag, server version on success, or error message.
	 */
	static async ioControl(_mode: ConnectionMode, command: string, params?: Record<string, unknown>, _onProgress?: IoProgressCallback): Promise<IoControlResult> {
		try {
			switch (command) {
				case 'test': {
					const hostUrl = params?.hostUrl as string;
					const apiKey = params?.apiKey as string;
					if (!hostUrl) return { success: false, error: 'Host URL is required' };

					// Dynamic require — avoids bundling the SDK into the webview; only used at runtime
					const { RocketRideClient } = require('rocketride');
					const client = new RocketRideClient({ persist: false });
					await client.connect(apiKey, { uri: hostUrl, timeout: 10000 });
					const version = client.getServerVersion?.() ?? null;
					await client.disconnect();
					return { success: true, data: { version } };
				}
				default:
					return { success: false, error: `Unknown command: ${command}` };
			}
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}
