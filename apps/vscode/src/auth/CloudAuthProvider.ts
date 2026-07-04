// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CloudAuthProvider — OAuth2 PKCE authentication for RocketRide Cloud.
 *
 * Manages the sign-in lifecycle only — authentication is separate from
 * connection. The stored token is picked up later by RemoteManager when
 * the user connects.
 *
 *   1. Generate PKCE challenge
 *   2. Open Zitadel authorize URL in browser
 *   3. Receive authorization code via vscode:// URI handler
 *   4. Exchange code for rr_* token via a temporary WebSocket connection
 *   5. Store token in VS Code SecretStorage + display name
 *   6. Disconnect the temporary connection — no persistent connection made
 *
 * The userToken is a persistent rr_* API key — no refresh needed.
 */

import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { generatePkce, buildAuthUrl } from './pkce';

import { EventEmitter } from 'events';

// =============================================================================
// CONSTANTS
// =============================================================================

const SECRET_KEY_TOKEN = 'rocketride.cloudToken';
const SECRET_KEY_NAME = 'rocketride.cloudUserName';
const REDIRECT_URI = `${vscode.env.uriScheme}://rocketride.rocketride/auth/callback`;

// =============================================================================
// CLASS
// =============================================================================

export class CloudAuthProvider implements vscode.UriHandler, vscode.Disposable {
	private static instance: CloudAuthProvider | undefined;

	private context: vscode.ExtensionContext | undefined;
	private pendingVerifier: string | null = null;
	private pendingGoogleOAuth = new Map<string, (tokens: string, state: string) => void>();
	private disposables: vscode.Disposable[] = [];
	private readonly _onDidChange = new EventEmitter();

	// --- Singleton -----------------------------------------------------------

	static getInstance(): CloudAuthProvider {
		if (!CloudAuthProvider.instance) {
			CloudAuthProvider.instance = new CloudAuthProvider();
		}
		return CloudAuthProvider.instance;
	}

	private constructor() {}

	// --- Lifecycle -----------------------------------------------------------

	initialize(context: vscode.ExtensionContext): void {
		this.context = context;
		this.disposables.push(vscode.window.registerUriHandler(this));
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}

	// --- Events --------------------------------------------------------------

	/** Fires after sign-in or sign-out completes. */
	get onDidChange() {
		return this._onDidChange;
	}

	// --- Sign In -------------------------------------------------------------

	async signIn(zitadelUrl: string, clientId: string): Promise<void> {
		if (!zitadelUrl || !clientId) {
			vscode.window.showErrorMessage('RocketRide Cloud sign-in required.');
			return;
		}

		const { verifier, challenge } = generatePkce();
		this.pendingVerifier = verifier;

		const authUrl = buildAuthUrl(zitadelUrl, clientId, REDIRECT_URI, challenge);
		await vscode.env.openExternal(vscode.Uri.parse(authUrl));
	}

	// --- Google node OAuth ---------------------------------------------------

	/**
	 * Registers a one-shot callback to receive Google node-OAuth tokens once the
	 * broker's deep link (`/auth/google`) returns. Waiters are keyed by the
	 * node id that started the login (the broker echoes it inside `state`), so
	 * concurrent logins from different editors cannot overwrite or misroute
	 * each other. Google's consent screen can't render in a webview iframe,
	 * so the login runs in the system browser and returns via this deep link.
	 *
	 * @param nodeId   The pipeline node that initiated the login.
	 * @param callback Invoked with the raw `tokens` and `state` query strings.
	 * @return A disposer that unregisters the waiter (call on launch failure).
	 */
	setPendingGoogleOAuth(nodeId: string, callback: (tokens: string, state: string) => void): () => void {
		this.pendingGoogleOAuth.set(nodeId, callback);
		return () => {
			this.pendingGoogleOAuth.delete(nodeId);
		};
	}

	private handleGoogleOAuth(uri: vscode.Uri): void {
		const params = new URLSearchParams(uri.query);
		const error = params.get('oauth_error') || params.get('error');
		const tokens = params.get('tokens');
		const state = params.get('state') ?? '';

		// The broker echoes the originating node_id inside the state JSON; use
		// it to pick the matching waiter. Fall back to a sole waiter for broker
		// responses without one, and reject when the target is ambiguous.
		let nodeId: string | undefined;
		try {
			nodeId = (JSON.parse(state || '{}') as { node_id?: string }).node_id;
		} catch {
			/* malformed state, resolved below */
		}
		let callback = nodeId ? this.pendingGoogleOAuth.get(nodeId) : undefined;
		if (callback) {
			this.pendingGoogleOAuth.delete(nodeId as string);
		} else if (!nodeId && this.pendingGoogleOAuth.size === 1) {
			const [soleKey, soleCallback] = this.pendingGoogleOAuth.entries().next().value as [string, (tokens: string, state: string) => void];
			this.pendingGoogleOAuth.delete(soleKey);
			callback = soleCallback;
		}

		if (error) {
			vscode.window.showErrorMessage(`Google sign-in failed: ${params.get('error_description') || error}`);
			return;
		}
		if (!tokens) {
			vscode.window.showErrorMessage('Google sign-in failed: no tokens received.');
			return;
		}
		if (!callback) {
			vscode.window.showWarningMessage('Google sign-in completed, but no pipeline editor was waiting for it.');
			return;
		}
		callback(tokens, state);
	}

	// --- URI Handler ---------------------------------------------------------

	async handleUri(uri: vscode.Uri): Promise<void> {
		if (uri.path === '/auth/google') {
			this.handleGoogleOAuth(uri);
			return;
		}
		if (uri.path !== '/auth/callback') return;

		const params = new URLSearchParams(uri.query);
		const code = params.get('code');

		if (!code) {
			const error = params.get('error_description') || params.get('error') || 'No authorization code received';
			vscode.window.showErrorMessage(`RocketRide Cloud sign-in failed: ${error}`);
			this.pendingVerifier = null;
			return;
		}

		if (!this.pendingVerifier) {
			vscode.window.showErrorMessage('RocketRide Cloud sign-in failed: no pending authentication request.');
			return;
		}

		const verifier = this.pendingVerifier;
		this.pendingVerifier = null;

		// Exchange the code for a persistent rr_* token using a temporary
		// client connection. This is auth only — not a persistent connection.
		try {
			// Always use the cloud URI for token exchange -- the OAuth code must
			// be exchanged against the cloud server regardless of the current
			// connection mode (local, docker, etc.).
			const cloudUrl = process.env.ROCKETRIDE_URI;
			if (!cloudUrl) {
				vscode.window.showErrorMessage('RocketRide Cloud sign-in failed: cloud endpoint is not configured (ROCKETRIDE_URI).');
				return;
			}
			const tempClient = new RocketRideClient({ persist: false });
			const result = await tempClient.connect({ code, verifier, redirectUri: REDIRECT_URI }, { uri: cloudUrl });

			const token = (result as any)?.userToken || '';
			const displayName = (result as any)?.displayName || '';

			// Disconnect immediately — we only needed the token
			await tempClient.disconnect();

			if (token) {
				await this.storeToken(token);
				await this.storeUserName(displayName);
				this._onDidChange.emit('changed');
				vscode.window.showInformationMessage(`Signed in to RocketRide Cloud as ${displayName || 'user'}`);
			} else {
				vscode.window.showErrorMessage('RocketRide Cloud sign-in failed: no token received.');
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`RocketRide Cloud sign-in failed: ${msg}`);
		}
	}

	// --- Token Storage -------------------------------------------------------

	async storeToken(token: string): Promise<void> {
		if (!this.context) return;
		await this.context.secrets.store(SECRET_KEY_TOKEN, token);
	}

	async getToken(): Promise<string> {
		if (!this.context) return '';
		try {
			return (await this.context.secrets.get(SECRET_KEY_TOKEN)) || '';
		} catch {
			return '';
		}
	}

	async isSignedIn(): Promise<boolean> {
		const token = await this.getToken();
		return token.length > 0;
	}

	// --- User Name Storage ---------------------------------------------------

	async storeUserName(name: string): Promise<void> {
		if (!this.context) return;
		await this.context.secrets.store(SECRET_KEY_NAME, name);
	}

	async getUserName(): Promise<string> {
		if (!this.context) return '';
		try {
			return (await this.context.secrets.get(SECRET_KEY_NAME)) || '';
		} catch {
			return '';
		}
	}

	// --- Sign Out -------------------------------------------------------------

	async signOut(): Promise<void> {
		if (this.context) {
			await this.context.secrets.delete(SECRET_KEY_TOKEN);
			await this.context.secrets.delete(SECRET_KEY_NAME);
		}
		this._onDidChange.emit('changed');
	}
}
