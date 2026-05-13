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
// REMOTE MANAGER — connection backend for shell-ui (browser)
// =============================================================================
//
// Mirrors the VSCode extension's remote-manager.ts pattern.
// Handles credential validation and client connection for both cloud (OAuth2)
// and OSS (API key) server modes.
//
//   connect    → validate credential → connect client (with timeout)
//   disconnect → disconnect client
//
// No engine process management (that's VSCode-only via LocalManager).
// =============================================================================

import { RocketRideClient, ConnectResult } from 'rocketride';
import type { ManagerInfo } from 'shared';
import { BaseManager, ShellConnectionConfig } from './base-manager';
import { CONNECT_TIMEOUT_MS } from '../constants';

// =============================================================================
// REMOTE MANAGER
// =============================================================================

export class RemoteManager extends BaseManager {
	/** Cached server info from the most recent successful connection. */
	private serverInfo: ManagerInfo | null = null;

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	/**
	 * Connect the client to the remote server with the provided credential.
	 * Applies a timeout to prevent hanging indefinitely on unresponsive servers.
	 *
	 * @param client - The shared RocketRideClient instance.
	 * @param config - Connection configuration (URI + credential).
	 * @throws Error if connection times out or credential is rejected.
	 */
	async connect(client: RocketRideClient, config: ShellConnectionConfig): Promise<void> {
		// Validate that we have something to connect with
		if (!config.credential) {
			throw new Error('No credential provided for connection.');
		}

		// Login with timeout to avoid indefinite hangs (transport already attached)
		const result = await Promise.race([
			client.login(config.credential as string | { code: string; verifier: string; redirectUri: string }),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
			),
		]) as ConnectResult;

		// Validate the result — SDK resolves even on auth failure
		if (!result.userId) {
			throw new Error('Authentication failed: unknown user or invalid credentials.');
		}

		// Cache server info if available
		if (result.serverVersion) {
			this.serverInfo = {
				version: result.serverVersion,
				publishedAt: null,
			};
		}
	}

	/**
	 * Disconnect the client from the server.
	 *
	 * @param client - The shared RocketRideClient instance.
	 */
	async disconnect(client: RocketRideClient): Promise<void> {
		await client.disconnect();
		this.serverInfo = null;
	}

	/**
	 * Returns version info about the connected server.
	 */
	getInfo(): ManagerInfo | null {
		return this.serverInfo;
	}
}
