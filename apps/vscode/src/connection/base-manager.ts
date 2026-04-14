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
 * base-manager.ts - Abstract Base for Connection Backend Managers
 *
 * Defines the polymorphic interface that LocalManager, RemoteManager,
 * and future backends (Docker, Service, etc.) implement.
 *
 * ConnectionManager owns a single RocketRideClient and passes it to the
 * active manager. Each manager owns its full lifecycle:
 *
 *   connect    → do whatever is needed to get connected
 *               (install engine, start engine, validate creds, connect client)
 *   disconnect → do whatever is needed to tear down
 *               (disconnect client, stop engine if running)
 *
 * Events:
 *   'status'     (message: string)  — progress text for UI display
 *   'terminated' (details: { code, signal }) — backend died unexpectedly
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { RocketRideClient } from 'rocketride';
import { ConfigManagerInfo } from '../config';

export interface ManagerInfo {
	version: string;
	publishedAt: string;
}

export abstract class BaseManager extends EventEmitter {
	/**
	 * Do everything needed to get the client connected to a server.
	 * - LocalManager: install engine if needed, start if not running, connect client with retries
	 * - RemoteManager: validate credentials, connect client
	 */
	abstract connect(client: RocketRideClient, config: ConfigManagerInfo, token?: vscode.CancellationToken): Promise<void>;

	/**
	 * Do everything needed to tear down.
	 * - LocalManager: disconnect client, stop engine if running
	 * - RemoteManager: disconnect client
	 */
	abstract disconnect(client: RocketRideClient): Promise<void>;

	/**
	 * Returns version info for the backend, or null if not applicable.
	 */
	abstract getInfo(): ManagerInfo | null;
}
