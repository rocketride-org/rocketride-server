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
 * Defines the polymorphic interface that EngineManager (local) and
 * CloudManager (cloud/onprem) both implement. ConnectionManager holds
 * a single BaseManager reference and never branches on connection mode.
 *
 * Events:
 *   'status'     (message: string)  — progress text for UI display
 *   'terminated' (details: { code, signal }) — backend died unexpectedly
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { ConfigManagerInfo } from '../config';

export interface ManagerInfo {
	version: string;
	publishedAt: string;
}

export abstract class BaseManager extends EventEmitter {
	/**
	 * Prepare the backend for connections.
	 * - EngineManager: install engine + spawn process
	 * - CloudManager: validate credentials
	 *
	 * Emits 'status' events with progress messages during execution.
	 */
	abstract start(config: ConfigManagerInfo, token?: vscode.CancellationToken): Promise<void>;

	/**
	 * Tear down the backend.
	 * - EngineManager: stop the engine process
	 * - CloudManager: no-op
	 */
	abstract stop(): Promise<void>;

	/**
	 * Returns version info for the backend, or null if not applicable.
	 * - EngineManager: { version, publishedAt } from installed engine
	 * - CloudManager: null
	 */
	abstract getInfo(): ManagerInfo | null;
}
