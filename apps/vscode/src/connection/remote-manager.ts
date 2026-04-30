// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * remote-manager.ts - Remote Backend Manager (cloud, docker, service, on-prem)
 *
 * Handles credential validation and client connection for remote server modes.
 * No engine process to manage:
 *
 *   connect    → validate credentials → connect client
 *   disconnect → disconnect client
 *
 * Cloud mode uses the CloudAuthProvider token (rr_* persistent key).
 * Docker/Service modes use the env-derived API key (default MYAPIKEY).
 * On-prem mode uses the user-provided API key.
 */

import { RocketRideClient } from 'rocketride';
import { BaseManager, ManagerInfo } from './base-manager';
import { ConfigManagerInfo } from '../config';
import { connectionModeRequiresApiKey, connectionModeUsesOAuth } from '../shared/util/connectionModeAuth';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';

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

		// Cloud mode: use the stored cloud token (rr_* persistent key)
		if (connectionModeUsesOAuth(config.connectionMode)) {
			const cloudAuth = CloudAuthProvider.getInstance();
			const token = await cloudAuth.getToken();
			if (!token) {
				throw new Error('Not signed in to RocketRide Cloud. Open Settings and click Sign In.');
			}
			await client.connect(token, { uri: config.hostUrl });
			return;
		}

		// On-prem: user-provided API key
		if (connectionModeRequiresApiKey(config.connectionMode) && !config.apiKey) {
			throw new Error('API key is required for on-prem connections. Configure it in Settings.');
		}

		// Docker, Service, On-prem: use config.apiKey (auto-derived or user-provided)
		await client.connect(config.apiKey, { uri: config.hostUrl });
	}

	async disconnect(client: RocketRideClient): Promise<void> {
		await client.disconnect();
	}

	getInfo(): ManagerInfo | null {
		return null;
	}
}
