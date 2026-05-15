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
// CONNECTION TYPES — shared contract for shell-ui, VSCode, and any future host
// =============================================================================
//
// Both hosts import these types from 'shared'. VSCode extends ConnectionState
// with engine-specific states; shell-ui uses the base set.
//
// Keeping these in the shared package ensures both platforms agree on the
// state machine vocabulary and status structure.
// =============================================================================

// =============================================================================
// CONNECTION STATE
// =============================================================================

/**
 * Core connection states shared by all hosts.
 *
 * VSCode extends this with engine-specific states (DOWNLOADING_ENGINE,
 * STARTING_ENGINE, etc.) via its own local enum that includes these values.
 */
export enum ConnectionState {
	/** No active connection. */
	DISCONNECTED = 'disconnected',

	/** Connecting to WebSocket (after any engine/credential setup). */
	CONNECTING = 'connecting',

	/** Successfully connected and authenticated. */
	CONNECTED = 'connected',

	/** Connection attempt failed (network, timeout, server error). */
	FAILED = 'failed',

	/** Authentication was rejected by the server (bad/expired/revoked key). */
	AUTH_FAILED = 'auth-failed',
}

// =============================================================================
// CONNECTION MODE
// =============================================================================

/**
 * The mode of connection — determines credential requirements and server type.
 *
 * - cloud:  RocketRide.ai SaaS (OAuth2 PKCE via Zitadel)
 * - local:  Local engine (VSCode only — no credentials needed)
 * - onprem: Self-hosted server (API key + host URL)
 * - docker: Docker container (auto-derived API key)
 * - service: Service account (auto-derived API key)
 * - oss:    Open-source server mode (optional API key)
 */
export type ConnectionMode = 'cloud' | 'local' | 'onprem' | 'docker' | 'service' | 'oss';

// =============================================================================
// CONNECTION STATUS
// =============================================================================

/**
 * Structured connection status for UI display and state tracking.
 *
 * Both hosts produce this object and expose it via getConnectionStatus().
 * UI components consume it for status bars, spinners, retry indicators, etc.
 */
export interface ConnectionStatus {
	/** Current connection state. */
	state: ConnectionState;

	/** How this connection reaches the server. */
	connectionMode: ConnectionMode;

	/** Timestamp of last successful connection. */
	lastConnected?: Date;

	/** Last error message (cleared on successful connect). */
	lastError?: string;

	/** True if we have necessary credentials/config to attempt connection. */
	hasCredentials: boolean;

	/** Current retry attempt number (0 when not retrying). */
	retryAttempt: number;

	/** Maximum retry attempts before giving up. */
	maxRetryAttempts: number;

	/** Detailed progress message (e.g. "Reconnecting...", download %). */
	progressMessage?: string;
}

// =============================================================================
// MANAGER INFO
// =============================================================================

/**
 * Version metadata returned by a BaseManager's getInfo() method.
 * Used to display server/engine version in status UI.
 */
export interface ManagerInfo {
	/** Semantic version string (e.g. "1.2.3") or null if unknown. */
	version: string | null;

	/** ISO 8601 publish date or null if unknown. */
	publishedAt: string | null;
}

// =============================================================================
// AUTH PROVIDER INTERFACE
// =============================================================================

/**
 * Common interface for authentication providers across all hosts.
 *
 * Both CloudAuthProvider (OAuth2 PKCE) and ApiKeyAuthProvider implement this.
 * The shell and VSCode each have platform-specific implementations, but the
 * contract is identical.
 */
export interface IAuthProvider {
	/** Initiate the sign-in flow (may redirect browser or open external URL). */
	signIn(...args: unknown[]): Promise<void>;

	/** Clear stored credentials and sign out. */
	signOut(): Promise<void>;

	/** Retrieve the stored authentication token, or null/empty if not signed in. */
	getToken(): Promise<string | null>;

	/** Returns true if a valid token is stored. */
	isSignedIn(): Promise<boolean>;
}
