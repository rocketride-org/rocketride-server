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
// API KEY AUTH PROVIDER — API key authentication for shell-ui (OSS mode)
// =============================================================================
//
// Simple auth provider for open-source / local server mode.
// User enters an API key (or leaves blank for open access), which is stored
// in sessionStorage and passed to ConnectionManager.connect().
//
// Implements the same IAuthProvider interface as CloudAuthProvider so the
// ConnectionManager can use either interchangeably.
// =============================================================================

import type { IAuthProvider } from 'shared';
import { LS_TOKEN } from '../constants';

// =============================================================================
// CLASS
// =============================================================================

export class ApiKeyAuthProvider implements IAuthProvider {
	// =========================================================================
	// SINGLETON
	// =========================================================================

	private static instance: ApiKeyAuthProvider;

	/** Returns the singleton ApiKeyAuthProvider instance. */
	public static getInstance(): ApiKeyAuthProvider {
		if (!ApiKeyAuthProvider.instance) {
			ApiKeyAuthProvider.instance = new ApiKeyAuthProvider();
		}
		return ApiKeyAuthProvider.instance;
	}

	private constructor() {}

	// =========================================================================
	// SIGN IN
	// =========================================================================

	/**
	 * Sign in with an API key.
	 *
	 * Stores the key in sessionStorage for the current session. An empty string
	 * is valid (some OSS servers allow unauthenticated access).
	 *
	 * @param apiKey - The API key to store.
	 */
	public async signIn(apiKey?: string): Promise<void> {
		const key = typeof apiKey === 'string' ? apiKey : '';
		await this.storeToken(key);
	}

	// =========================================================================
	// TOKEN STORAGE
	// =========================================================================

	/**
	 * Store the API key.
	 *
	 * @param token - The API key string to persist.
	 */
	private async storeToken(token: string): Promise<void> {
		try {
			sessionStorage.setItem(LS_TOKEN, token);
		} catch (e) {
			console.error('[ApiKeyAuthProvider] Failed to store token:', e);
		}
	}

	/**
	 * Retrieve the stored API key.
	 *
	 * @returns The API key string, or null if not stored.
	 */
	public async getToken(): Promise<string | null> {
		try {
			const token = sessionStorage.getItem(LS_TOKEN);
			// For API key mode, empty string is valid (open access)
			return token;
		} catch {
			return null;
		}
	}

	/**
	 * Returns true if a token is stored.
	 * Note: empty string counts as "signed in" for OSS mode (open access).
	 */
	public async isSignedIn(): Promise<boolean> {
		try {
			return sessionStorage.getItem(LS_TOKEN) !== null;
		} catch {
			return false;
		}
	}

	// =========================================================================
	// SIGN OUT
	// =========================================================================

	/**
	 * Clear stored API key.
	 */
	public async signOut(): Promise<void> {
		try {
			sessionStorage.removeItem(LS_TOKEN);
		} catch (e) {
			console.error('[ApiKeyAuthProvider] Failed to clear token:', e);
		}
	}
}
