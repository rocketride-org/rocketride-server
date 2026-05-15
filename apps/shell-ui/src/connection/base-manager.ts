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
// BASE MANAGER — Abstract base for connection backend managers (shell-ui)
// =============================================================================
//
// Mirrors the VSCode extension's base-manager.ts pattern. Shell-ui only needs
// RemoteManager (no local engine management), but the abstraction is preserved
// for consistency and future extensibility.
//
// ConnectionManager owns the RocketRideClient and passes it to the active
// manager. Each manager handles its full connect/disconnect lifecycle.
// =============================================================================

import { RocketRideClient } from 'rocketride';
import type { ManagerInfo } from 'shared';

// =============================================================================
// SHELL CONFIG (passed to manager.connect)
// =============================================================================

/**
 * Configuration passed to the manager when connecting.
 * Contains the resolved server URI and credential needed for connection.
 */
export interface ShellConnectionConfig {
	/** Server URI (WebSocket/HTTP base). */
	uri: string;

	/** Authentication credential (token string or PKCE exchange object). */
	credential: string | { code: string; verifier: string; redirectUri: string };
}

// =============================================================================
// ABSTRACT BASE
// =============================================================================

/**
 * Abstract base class for connection backend managers.
 *
 * Mirrors the VSCode extension's BaseManager pattern:
 * - connect()    → do whatever is needed to get the client connected
 * - disconnect() → tear down the connection
 * - getInfo()    → return version metadata about the connected server
 *
 * Shell-ui uses only RemoteManager. The abstract class exists so the
 * ConnectionManager can reference the backend polymorphically.
 */
export abstract class BaseManager {
	/**
	 * Connect the client to a server using the provided configuration.
	 *
	 * @param client - The shared RocketRideClient instance.
	 * @param config - Connection configuration (URI + credential).
	 */
	abstract connect(client: RocketRideClient, config: ShellConnectionConfig): Promise<void>;

	/**
	 * Disconnect the client from the server.
	 *
	 * @param client - The shared RocketRideClient instance.
	 */
	abstract disconnect(client: RocketRideClient): Promise<void>;

	/**
	 * Returns version info about the connected server, or null if unavailable.
	 */
	abstract getInfo(): ManagerInfo | null;
}
