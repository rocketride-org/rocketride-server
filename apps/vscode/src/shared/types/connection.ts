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
 * Comprehensive connection status enum that includes engine states
 */

/**
 * Represents the current connection states of the connection manager or socket.
 * Tracks the state of both engine processes and WebSocket connections.
 */
export enum ConnectionState {
	/** No active connection or engine process */
	DISCONNECTED = 'disconnected',

	/** Local mode: engine is being downloaded from GitHub */
	DOWNLOADING_ENGINE = 'downloading-engine',

	/** Local mode: engine process is starting up */
	STARTING_ENGINE = 'starting-engine',

	/** Local mode: engine process failed to start (e.g. exited during startup) */
	ENGINE_STARTUP_FAILED = 'engine-startup-failed',

	/** Connecting to WebSocket (cloud or local after engine ready) */
	CONNECTING = 'connecting',

	/** Successfully connected and ready for debugging */
	CONNECTED = 'connected',

	/** Connection attempt failed, cleanup required */
	FAILED = 'failed',

	/** Authentication was rejected by the server (bad/expired/revoked key) */
	AUTH_FAILED = 'auth-failed',

	/** Local mode: engine process is shutting down */
	STOPPING_ENGINE = 'stopping-engine',
}

/**
 * Development connection mode
 * - cloud: RocketRide.ai cloud (needs account/API key)
 * - onprem: Your own hosted server (needs host URL + API key)
 * - local: Your local machine (just needs port to connect to)
 */
export type ConnectionMode = 'cloud' | 'docker' | 'service' | 'onprem' | 'local';

/**
 * Connection status tracking for UI updates and status monitoring
 */
export interface ConnectionStatus {
	/** Current connection status */
	state: ConnectionState;

	/** Current connection mode */
	connectionMode: ConnectionMode;

	/** Timestamp of last successful connection */
	lastConnected?: Date;

	/** Last error message */
	lastError?: string;

	/** True if we have necessary credentials/config to connect */
	hasCredentials: boolean;

	/** Current retry attempt number (0 when not retrying) */
	retryAttempt: number;

	/** Maximum retry attempts */
	maxRetryAttempts: number;

	/** Detailed progress message (e.g. download progress) shown during connecting states */
	progressMessage?: string;
}
