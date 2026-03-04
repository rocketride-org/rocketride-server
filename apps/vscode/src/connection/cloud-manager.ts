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
 * cloud-manager.ts - Cloud/On-prem Backend Manager
 *
 * Manages the cloud or on-prem backend: validates that credentials
 * are configured before ConnectionManager connects the WebSocket client.
 */

import { BaseManager, ManagerInfo } from './base-manager';
import { ConfigManagerInfo } from '../config';

export class CloudManager extends BaseManager {

	/**
	 * Validates that cloud/onprem credentials are configured.
	 */
	public async start(config: ConfigManagerInfo): Promise<void> {
		this.emit('status', 'Validating credentials...');

		if (!config.apiKey) {
			throw new Error('API key is required for cloud/on-prem connections. Configure it in Settings.');
		}
		if (!config.hostUrl) {
			throw new Error('Host URL is required for cloud/on-prem connections. Configure it in Settings.');
		}
	}

	/**
	 * No-op — cloud connections have no backend process to stop.
	 */
	public async stop(): Promise<void> {
		// Nothing to do
	}

	/**
	 * Cloud mode has no locally installed engine.
	 */
	public getInfo(): ManagerInfo | null {
		return null;
	}
}
