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
 * remote-manager.ts - Remote Backend Manager (cloud, on-prem, service, etc.)
 *
 * Handles credential validation and client connection for remote server modes.
 * No engine process to manage:
 *
 *   connect    → validate credentials → connect client
 *   disconnect → disconnect client
 */

import { RocketRideClient } from 'rocketride';
import { BaseManager, ManagerInfo } from './base-manager';
import { ConfigManagerInfo } from '../config';
import { connectionModeRequiresApiKey } from '../shared/util/connectionModeAuth';

// =============================================================================
// MANAGER
// =============================================================================

export class RemoteManager extends BaseManager {
	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	async connect(client: RocketRideClient, config: ConfigManagerInfo): Promise<void> {
		if (!config.hostUrl) {
			throw new Error('Host URL is required for remote connections. Configure it in Settings.');
		}
		if (connectionModeRequiresApiKey(config.connectionMode) && !config.apiKey) {
			throw new Error('API key is required for cloud connections. Configure it in Settings.');
		}

		await client.connect(config.apiKey, { uri: config.hostUrl });
	}

	async disconnect(client: RocketRideClient): Promise<void> {
		await client.disconnect();
	}

	getInfo(): ManagerInfo | null {
		return null;
	}
}
