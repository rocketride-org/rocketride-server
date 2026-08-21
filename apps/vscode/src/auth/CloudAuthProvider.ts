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
 *   5. STAGE the session in memory — the settings screens are transactional,
 *      so the token reaches SecretStorage only when the user saves
 *      (commitPendingChanges), keyed to the server that minted it
 *   6. Disconnect the temporary connection — no persistent connection made
 *
 * Sign-out from a settings screen is staged the same way (stageSignOut) and
 * deletes the stored session only on save. Direct surfaces (sidebar menu,
 * account page) still use signOut(), which applies immediately.
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
const SECRET_KEY_URL = 'rocketride.cloudServerUrl';
const REDIRECT_URI = `${vscode.env.uriScheme}://rocketride.rocketride/auth/callback`;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Comparable identity of a server URL — origin when parseable, else the
 * trimmed string sans trailing slashes. Mirrors CloudPanel's serverIdentity()
 * so host-side commit checks agree with what the webview showed the user.
 *
 * @param url - The server URL to normalize.
 * @returns Lowercased origin (or trimmed string) usable for equality checks.
 */
function serverIdentity(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, '');
	try {
		return new URL(trimmed).origin.toLowerCase();
	} catch {
		return trimmed.toLowerCase();
	}
}

/** A completed browser sign-in held in memory until the user saves. */
export interface PendingCloudSession {
	token: string;
	displayName: string;
	/** The server that minted the token — the ONLY server it is valid on. */
	cloudUrl: string;
}

/** Outcome of committing staged auth changes on save. */
export interface CommitPendingResult {
	/** True when the STORED session changed (sign-in stored or sign-out
	 *  executed) — live cloud connections must be re-established. */
	committed: boolean;
	/** True when a staged sign-out deleted the stored session. */
	signedOut: boolean;
	/** Set when a staged sign-in was DROPPED because no saved cloud
	 *  connection targets the server that minted it (the minting URL). */
	droppedMismatch: string | null;
}

// =============================================================================
// CLASS
// =============================================================================

export class CloudAuthProvider implements vscode.UriHandler, vscode.Disposable {
	private static instance: CloudAuthProvider | undefined;

	private context: vscode.ExtensionContext | undefined;
	private pendingVerifier: string | null = null;
	/** The cloud server the in-flight sign-in exchanges its code against —
	 * captured at signIn() because the callback arrives later. */
	private pendingCloudUrl: string | null = null;
	/** Set when the LAST sign-in attempt came back waitlisted (auth fine,
	 * access not yet granted, no token minted). In-memory only — the
	 * waitlist is a server fact and must never persist into staleness; the
	 * panels render it as a friendly banner for this host's lifetime. */
	private waitlistedName: string | null = null;
	/** Staged (uncommitted) session from a completed browser sign-in — the
	 * settings screens are transactional, so this reaches SecretStorage only
	 * via commitPendingChanges() when the user saves. In-memory only: closing
	 * the settings surface without saving discards it. */
	private pendingSession: PendingCloudSession | null = null;
	/** Sign-out staged from a settings screen — the stored session is deleted
	 * only when the user saves (commitPendingChanges). */
	private pendingSignOut = false;
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

	/**
	 * Start the browser PKCE round trip.
	 *
	 * @param zitadelUrl - Zitadel issuer (shared across all environments).
	 * @param clientId   - Zitadel VS Code application client id.
	 * @param cloudUrl   - The cloud server the OAuth code will be exchanged
	 *                     against (the caller's effective cloud target —
	 *                     nothing is baked into the extension). Captured
	 *                     alongside the verifier because the exchange happens
	 *                     later, in the deep-link callback.
	 */
	async signIn(zitadelUrl: string, clientId: string, cloudUrl: string): Promise<void> {
		if (!zitadelUrl || !clientId) {
			vscode.window.showErrorMessage('RocketRide Cloud sign-in required.');
			return;
		}
		if (!cloudUrl) {
			vscode.window.showErrorMessage('RocketRide Cloud sign-in failed: no cloud server is configured.');
			return;
		}

		const { verifier, challenge } = generatePkce();
		this.pendingVerifier = verifier;
		this.pendingCloudUrl = cloudUrl;

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
			// Exchange against the cloud server CAPTURED AT SIGN-IN — the
			// caller's effective cloud target (default cloud or the user's
			// custom server), never a value baked into the extension.
			const cloudUrl = this.pendingCloudUrl;
			this.pendingCloudUrl = null;
			if (!cloudUrl) {
				vscode.window.showErrorMessage('RocketRide Cloud sign-in failed: no cloud server was captured for this sign-in.');
				return;
			}
			const tempClient = new RocketRideClient({ persist: false });
			const result = await tempClient.connect({ code, verifier, redirectUri: REDIRECT_URI }, { uri: cloudUrl });

			const token = (result as any)?.userToken || '';
			const displayName = (result as any)?.displayName || '';
			const waitlisted = Boolean((result as any)?.waitlisted);

			// Disconnect immediately — we only needed the token
			await tempClient.disconnect();

			// Waitlisted account: authentication SUCCEEDED but access is not
			// granted yet — the server deliberately returns no token so no
			// session exists to store. Mirror the browser shell's waitlist
			// screen: record the state (the Cloud panels render it as a
			// friendly banner via cloud:status) and toast for surfaces
			// without a panel, instead of falling through to the generic
			// "no token received" failure.
			if (waitlisted) {
				this.waitlistedName = displayName;
				this._onDidChange.emit('changed');
				vscode.window.showInformationMessage(
					`Thanks for signing up${displayName ? `, ${displayName}` : ''}! Your RocketRide Cloud account is in the access queue — access is rolling out in waves, and we'll email you as soon as your account is activated.`
				);
				return;
			}
			this.waitlistedName = null;

			if (token) {
				// STAGE, don't store: the settings screens commit credentials
				// only on Save, together with the form fields the sign-in
				// belongs to (mode, custom server URL). The minting server
				// rides along because the token is only valid there — commit
				// refuses to store a session no saved connection targets.
				// No toast here: the Cloud panel renders the staged state
				// itself, and a notification would cover the Save footer.
				this.pendingSession = { token, displayName, cloudUrl };
				this.pendingSignOut = false;
				this._onDidChange.emit('changed');
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

	// --- Signed-In Server Storage --------------------------------------------

	/** Records the cloud server the current session's token was minted against. */
	async storeSignedInUrl(url: string): Promise<void> {
		if (!this.context) return;
		await this.context.secrets.store(SECRET_KEY_URL, url);
	}

	/** The cloud server of the CURRENT session ('' when signed out or unknown —
	 *  sessions minted before this field existed carry no URL). */
	async getSignedInUrl(): Promise<string> {
		if (!this.context) return '';
		try {
			return (await this.context.secrets.get(SECRET_KEY_URL)) || '';
		} catch {
			return '';
		}
	}

	/** The display name of the last WAITLISTED sign-in attempt, or null when
	 *  the last attempt was not waitlisted (this host's lifetime only). */
	getWaitlistedName(): string | null {
		return this.waitlistedName;
	}

	// --- Staged Changes (transactional settings screens) ----------------------

	/** The staged sign-in awaiting Save, or null. Token deliberately omitted —
	 *  display surfaces never need it. */
	getPendingSession(): { displayName: string; cloudUrl: string } | null {
		if (!this.pendingSession) return null;
		return { displayName: this.pendingSession.displayName, cloudUrl: this.pendingSession.cloudUrl };
	}

	/** True when a sign-out is staged and will apply on the next save. */
	hasPendingSignOut(): boolean {
		return this.pendingSignOut;
	}

	/**
	 * Stages a sign-out from a settings screen. A staged sign-in is simply
	 * discarded (nothing was stored yet); a stored session is marked for
	 * deletion on the next save.
	 */
	async stageSignOut(): Promise<void> {
		// The staged sign-in and the stored session are INDEPENDENT: a user
		// can re-sign-in (staging a session) while an older session is still
		// stored, then click sign out. Discarding only the staged session
		// would leave the stored one alive past the save — so always drop
		// the staged one AND mark a stored session for deletion.
		this.pendingSession = null;
		if (await this.isSignedIn()) {
			this.pendingSignOut = true;
		}
		this._onDidChange.emit('changed');
	}

	/** Discards any staged sign-in/sign-out (Cancel, or the settings surface
	 *  closing without a save). The stored session is untouched. */
	clearPendingChanges(): void {
		if (!this.pendingSession && !this.pendingSignOut) return;
		this.pendingSession = null;
		this.pendingSignOut = false;
		this._onDidChange.emit('changed');
	}

	/**
	 * Commits staged auth changes — called by the save flows AFTER the form
	 * fields are persisted, so credentials and the config they belong to land
	 * atomically from the user's point of view.
	 *
	 * @param validTargets - The resolved hostUrls of every saved connection
	 *                       group in cloud mode. A staged session whose minting
	 *                       server matches none of them is DROPPED, never
	 *                       stored — the token is only valid on its minting
	 *                       server, and storing it would recreate the
	 *                       mismatched-session class of failures.
	 */
	async commitPendingChanges(validTargets: string[]): Promise<CommitPendingResult> {
		let committed = false;
		let signedOut = false;
		let droppedMismatch: string | null = null;
		let stagedStateChanged = false;

		// Step 1: staged sign-out deletes the stored session.
		if (this.pendingSignOut) {
			this.pendingSignOut = false;
			stagedStateChanged = true;
			if (this.context) {
				await this.context.secrets.delete(SECRET_KEY_TOKEN);
				await this.context.secrets.delete(SECRET_KEY_NAME);
				await this.context.secrets.delete(SECRET_KEY_URL);
			}
			committed = true;
			signedOut = true;
		}

		// Step 2: staged sign-in stores the session — only when a saved cloud
		// connection actually targets the server that minted it.
		const pending = this.pendingSession;
		if (pending) {
			this.pendingSession = null;
			stagedStateChanged = true;
			const targetMatches = validTargets.some((target) => target && serverIdentity(target) === serverIdentity(pending.cloudUrl));
			if (targetMatches) {
				await this.storeToken(pending.token);
				await this.storeUserName(pending.displayName);
				await this.storeSignedInUrl(pending.cloudUrl);
				committed = true;
			} else {
				droppedMismatch = pending.cloudUrl;
			}
		}

		if (stagedStateChanged) {
			this._onDidChange.emit('changed');
		}
		return { committed, signedOut, droppedMismatch };
	}

	// --- Sign Out -------------------------------------------------------------

	/**
	 * Immediate sign-out for DIRECT surfaces (sidebar menu, account page) —
	 * settings screens stage via stageSignOut() instead. Also discards any
	 * staged changes so no stale pending session survives the sign-out.
	 */
	async signOut(): Promise<void> {
		if (this.context) {
			await this.context.secrets.delete(SECRET_KEY_TOKEN);
			await this.context.secrets.delete(SECRET_KEY_NAME);
			await this.context.secrets.delete(SECRET_KEY_URL);
		}
		this.pendingSession = null;
		this.pendingSignOut = false;
		this.waitlistedName = null;
		this._onDidChange.emit('changed');
	}
}
