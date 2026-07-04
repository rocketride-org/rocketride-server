// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// CLOUD AUTH PROVIDER — OAuth2 PKCE authentication for shell-ui (browser)
// =============================================================================
//
// Mirrors the VSCode extension's CloudAuthProvider class pattern.
// Manages the sign-in lifecycle separately from connection:
//
//   1. Generate PKCE challenge
//   2. Full-page redirect to Zitadel authorize endpoint
//   3. Browser redirects back with ?code= parameter
//   4. handleCallback() exchanges code for token via the ConnectionManager
//   5. Token stored in sessionStorage (browser equivalent of SecretStorage)
//
// The stored token is picked up by ConnectionManager.connect() — auth is
// decoupled from connection, same as VSCode.
// =============================================================================

import type { IAuthProvider } from 'shared';
import { generatePkce, buildAuthUrl, getStoredVerifier, clearStoredVerifier } from '../util/pkce';
import { LS_TOKEN, SS_PENDING_APP_ID } from '../constants';

// =============================================================================
// CLASS
// =============================================================================

export class CloudAuthProvider implements IAuthProvider {
	// =========================================================================
	// SINGLETON
	// =========================================================================

	private static instance: CloudAuthProvider;

	/** Returns the singleton CloudAuthProvider instance. */
	public static getInstance(): CloudAuthProvider {
		if (!CloudAuthProvider.instance) {
			CloudAuthProvider.instance = new CloudAuthProvider();
		}
		return CloudAuthProvider.instance;
	}

	private constructor() {}

	// =========================================================================
	// CONFIGURATION
	// =========================================================================

	/** Zitadel OAuth2 authority URL. */
	private zitadelUrl = '';

	/** Zitadel OAuth2 client ID. */
	private clientId = '';

	/**
	 * Initialize with Zitadel configuration.
	 * Must be called before signIn().
	 *
	 * @param config - Zitadel OAuth2 configuration.
	 */
	public initialize(config: { zitadelUrl: string; clientId: string }): void {
		this.zitadelUrl = config.zitadelUrl;
		this.clientId = config.clientId;
	}

	/**
	 * Clean up resources.
	 */
	public dispose(): void {
		// No persistent resources in browser — just clear config
		this.zitadelUrl = '';
		this.clientId = '';
	}

	// =========================================================================
	// SIGN IN (redirect to Zitadel)
	// =========================================================================

	/**
	 * Initiate OAuth2 PKCE sign-in by redirecting to Zitadel.
	 *
	 * Generates a PKCE challenge, stores the verifier in sessionStorage
	 * (survives the redirect), and navigates the browser to Zitadel's
	 * authorize endpoint.
	 *
	 * @param appId - Optional app ID to activate after sign-in completes.
	 * @param register - If true, shows Zitadel's signup form instead of login.
	 */
	public async signIn(appId?: string, register?: boolean): Promise<void> {
		if (!this.zitadelUrl || !this.clientId) {
			throw new Error('CloudAuthProvider not initialized — call initialize() first.');
		}

		// Store the target app ID so we can restore it after the redirect
		if (appId) {
			try { sessionStorage.setItem(SS_PENDING_APP_ID, appId); } catch (e) {
				console.error('[CloudAuthProvider] Failed to store pending app ID:', e);
			}
		}

		// Generate PKCE challenge (stores verifier in sessionStorage automatically)
		const { challenge } = await generatePkce();

		// Build the authorization URL
		const url = buildAuthUrl(
			this.zitadelUrl,
			this.clientId,
			window.location.origin,
			challenge,
			register,
		);

		// assign() (not replace()) so the landing page stays in history — the
		// browser back button from Zitadel returns the user to where they came
		// from. Zitadel's own login page (cross-origin) still lingers one step
		// back from the app after login; we can't delete that entry from JS,
		// but bootstrap() recovers gracefully if a stale ?code is revisited.
		window.location.assign(url);
	}

	// =========================================================================
	// CALLBACK (handle OAuth redirect back)
	// =========================================================================

	/**
	 * Handle the OAuth callback after Zitadel redirects back with ?code=.
	 *
	 * Retrieves the stored PKCE verifier and returns the exchange payload
	 * that should be passed to ConnectionManager.connect().
	 *
	 * @param code - The authorization code from the URL.
	 * @returns The PKCE exchange object for client.connect(), or null if
	 *          the verifier is missing (stale/expired session).
	 */
	public handleCallback(code: string): { code: string; verifier: string; redirectUri: string } | null {
		// Retrieve and clear the stored verifier
		const verifier = getStoredVerifier();
		clearStoredVerifier();

		if (!verifier) {
			console.error('[CloudAuthProvider] No PKCE verifier found — callback may be stale.');
			return null;
		}

		// Strip the ?code= from the URL so refreshes don't re-exchange
		window.history.replaceState({}, '', window.location.pathname);

		return {
			code,
			verifier,
			redirectUri: window.location.origin,
		};
	}

	// =========================================================================
	// TOKEN STORAGE (sessionStorage — browser equivalent of SecretStorage)
	// =========================================================================

	/**
	 * Store an authentication token.
	 *
	 * @param token - The token string to persist.
	 */
	public async storeToken(token: string): Promise<void> {
		try {
			sessionStorage.setItem(LS_TOKEN, token);
		} catch (e) {
			console.error('[CloudAuthProvider] Failed to store token:', e);
		}
	}

	/**
	 * Retrieve the stored authentication token.
	 *
	 * @returns The token string, or null if not stored.
	 */
	public async getToken(): Promise<string | null> {
		try {
			const token = sessionStorage.getItem(LS_TOKEN);
			return token || null;
		} catch {
			return null;
		}
	}

	/**
	 * Returns true if a token is stored (user has signed in before).
	 */
	public async isSignedIn(): Promise<boolean> {
		const token = await this.getToken();
		return token !== null && token.length > 0;
	}

	// =========================================================================
	// SIGN OUT
	// =========================================================================

	/**
	 * Clear stored credentials and sign out.
	 */
	public async signOut(): Promise<void> {
		try {
			sessionStorage.removeItem(LS_TOKEN);
		} catch (e) {
			console.error('[CloudAuthProvider] Failed to clear token:', e);
		}
	}
}
