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
	 * @param params - Optional params. For `signin`, `zitadelUrl` and `clientId` are
	 *                 a PAIR: supply both to target another tenant, or neither to
	 *                 use the values baked in at build time. Supplying only
	 *                 `zitadelUrl` is rejected — a client id is a registration
	 *                 inside a tenant, so the baked one is meaningless against a
	 *                 different one.
	 * @returns Result with success flag and optional data/error.
	 */
	static async ioControl(_mode: ConnectionMode, command: string, params?: Record<string, unknown>, _onProgress?: IoProgressCallback): Promise<IoControlResult> {
		const cloudAuth = CloudAuthProvider.getInstance();
		try {
			switch (command) {
				case 'signin': {
					// zitadelUrl and clientId are ONE setting, not two.
					//
					// A Zitadel client id is a registration inside a specific tenant and
					// project. Pointing the extension at tenant B while keeping an id
					// that names an application in tenant A sends A's client id to B,
					// which fails with the same class of error this change exists to
					// kill. So they travel together: either the caller supplies the
					// pair, or neither is taken from the caller.
					//
					// The default is the BAKED pair. esbuild.js inlines
					// RR_ZITADEL_VSCODE_CLIENT_ID at build time and it is the NATIVE
					// app — public client, PKCE, and the only registration listing the
					// `${vscode.env.uriScheme}://rocketride.rocketride/auth/callback`
					// redirects this extension uses.
					//
					// Before this, params won unconditionally. The caller is the
					// environment webview, which passes RR_ZITADEL_CLIENT_ID — the WEB
					// app — so every sign-in ran PKCE against the wrong registration
					// with a native redirect. It failed for every user on every editor
					// and every version, and stopped the India hackathon on 2026-08-24.
					const callerTenant = params?.zitadelUrl as string | undefined;
					const callerClientId = params?.clientId as string | undefined;

					// Half a pair is rejected here rather than passed through. Without
					// this, a caller supplying zitadelUrl and no clientId sends '' as
					// the client id, CloudAuthProvider's own guard shows "RocketRide
					// Cloud sign-in required" — which describes a signed-out user, not
					// a malformed call — and signIn returns void, so this case fell
					// through to `success: true`. The caller would be told sign-in
					// succeeded when no browser ever opened.
					//
					// That is the same shape as the failures this whole change came
					// from: reporting success about work that never happened.
					if (callerTenant && !callerClientId) {
						return {
							success: false,
							error: 'signin: zitadelUrl was supplied without clientId. They are a pair — a client id is a registration inside a tenant, so the built-in one cannot be used against a different tenant. Pass both, or neither.',
						};
					}

					await cloudAuth.signIn(
						callerTenant || process.env.RR_ZITADEL_URL || '',
						callerTenant
							? (callerClientId as string)
							: (process.env.RR_ZITADEL_VSCODE_CLIENT_ID || '')
					);
					return { success: true };
				}
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
