// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-cloud.ts — Cloud engine backend.
 *
 * Cloud mode has no engine to manage — the server runs on RocketRide.ai.
 * This backend just validates credentials and resolves the connection URI.
 *
 * Authentication uses the CloudAuthProvider OAuth token.
 */

import * as vscode from 'vscode';
import { EngineBackend, type StatusEmitter, type EngineInfo, type EngineBackendStatus, type IoControlResult, type IoProgressCallback } from '../engine-backend';
import type { ConnectionMode } from '../../config';
import { CloudAuthProvider } from '../../auth/CloudAuthProvider';
import type { ConnectionGroupConfig } from '../../config';

// =============================================================================
// CLOUD ENGINE BACKEND
// =============================================================================

export class EngineCloud extends EngineBackend {
	/** The cloud server URL (set after a successful start). */
	private hostUrl?: string;

	/**
	 * @param emitStatus - Callback to emit status events to EngineManager.
	 */
	constructor(emitStatus: StatusEmitter) {
		super(emitStatus);
	}

	/**
	 * Validates the cloud host URL and emits 'ready' with the URI.
	 * Authentication is handled by ConnectionManager (not here).
	 */
	async start(config: ConnectionGroupConfig, _token?: vscode.CancellationToken): Promise<void> {
		if (!config.hostUrl) {
			this.hostUrl = undefined;
			this.emitStatus({ phase: 'error', message: 'Cloud host URL not configured', error: 'Host URL is required' });
			return;
		}

		this.hostUrl = config.hostUrl;
		this.emitStatus({
			phase: 'ready',
			message: 'Cloud server ready',
			uri: this.hostUrl,
		});
	}

	/** No process to stop in cloud mode. */
	async stop(): Promise<void> {
		this.hostUrl = undefined;
		this.emitStatus({ phase: 'idle', message: 'Disconnected from cloud' });
	}

	/** No local engine info in cloud mode. */
	getInfo(): EngineInfo | null {
		return null;
	}

	/** Re-emits the current status. */
	emitCurrentStatus(): void {
		if (this.hostUrl) {
			this.emitStatus({ phase: 'ready', message: 'Cloud server ready', uri: this.hostUrl });
		} else {
			this.emitStatus({ phase: 'idle', message: 'Not configured' });
		}
	}

	/** Nothing to dispose. */
	async dispose(): Promise<void> {}

	/**
	 * Probes the cloud server to check if it's reachable and get its version.
	 * Only needs to be called once — the cloud server is always "running" if reachable.
	 *
	 * @param hostUrl - The cloud host URL to probe. If not provided, returns a generic status.
	 */
	static async getStatus(hostUrl?: string): Promise<EngineBackendStatus> {
		if (!hostUrl) {
			return { state: 'running', version: null, publishedAt: null, installPath: null };
		}

		try {
			// Quick HTTP probe to check reachability
			const response = await fetch(`${hostUrl}/health`, { signal: AbortSignal.timeout(5000) });
			if (response.ok) {
				const data = await response.json().catch(() => ({}));
				return {
					state: 'running',
					version: (data as Record<string, string>).version ?? null,
					publishedAt: null,
					installPath: null,
				};
			}
			return { state: 'stopped', version: null, publishedAt: null, installPath: null };
		} catch {
			return { state: 'stopped', version: null, publishedAt: null, installPath: null };
		}
	}

	// =========================================================================
	// STATIC ioControl — cloud auth commands
	// =========================================================================

	/**
	 * Handles cloud-specific panel commands (signin, signout, status).
	 * Delegates OAuth flow to CloudAuthProvider.
	 *
	 * @param _mode - Connection mode (unused, always 'cloud').
	 * @param command - The command to execute: 'signin' | 'signout' | 'status'.
	 * @param params - Optional params; signin accepts `zitadelUrl` and `clientId`.
	 * @returns Result with success flag and optional data/error.
	 */
	static async ioControl(_mode: ConnectionMode, command: string, params?: Record<string, unknown>, _onProgress?: IoProgressCallback): Promise<IoControlResult> {
		const cloudAuth = CloudAuthProvider.getInstance();
		try {
			switch (command) {
				case 'signin':
					await cloudAuth.signIn(
						(params?.zitadelUrl as string) || process.env.RR_ZITADEL_URL || '',
						(params?.clientId as string) || process.env.RR_ZITADEL_VSCODE_CLIENT_ID || ''
					);
					return { success: true };
				case 'signout':
					await cloudAuth.signOut();
					return { success: true };
				case 'status': {
					const token = await cloudAuth.getToken();
					return { success: true, data: { signedIn: !!token } };
				}
				default:
					return { success: false, error: `Unknown command: ${command}` };
			}
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}
