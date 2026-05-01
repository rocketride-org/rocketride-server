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
 * DeployManager — manages the deployment connection, independent of the
 * development connection.
 *
 * Extends ConnectionManager to inherit all connection, engine management,
 * and event infrastructure. Overrides config accessors to read deploy-specific
 * settings (deployTargetMode, deployHostUrl, deployApiKey, etc.) instead of
 * development settings.
 *
 * Supports ALL modes including local — you can develop in the cloud and
 * deploy locally. Both dev and deploy LocalManagers share the same engine
 * install path but start separate engine processes on different ports.
 *
 * Architecture:
 *   ConnectionManager  — dev connection (singleton)
 *   DeployManager      — deploy connection (separate singleton, extends ConnectionManager)
 *   Both share:        — ConfigManager, CloudAuthProvider, engine install path
 */

import { ConnectionManager } from './connection';
import type { ConnectionMode } from '../config';

// =============================================================================
// DEPLOY MANAGER
// =============================================================================

export class DeployManager extends ConnectionManager {
	private static deployInstance: DeployManager;

	// =========================================================================
	// SINGLETON
	// =========================================================================

	/**
	 * Returns the singleton DeployManager instance.
	 * Separate from ConnectionManager.getInstance() — these are independent connections.
	 */
	public static getDeployInstance(): DeployManager {
		if (!DeployManager.deployInstance) {
			DeployManager.deployInstance = new DeployManager();
		}
		return DeployManager.deployInstance;
	}

	// =========================================================================
	// CONFIG OVERRIDES — read deploy-specific keys
	// =========================================================================

	/**
	 * Returns the deploy target mode instead of the development mode.
	 * Falls back to 'local' if deploy target is not configured (null).
	 */
	protected override getEffectiveConnectionMode(): ConnectionMode {
		return this.configManager.getConfig().deployTargetMode ?? 'local';
	}

	/**
	 * Returns deploy auto-connect setting.
	 */
	protected override getEffectiveAutoConnect(): boolean {
		return this.configManager.getConfig().deployAutoConnect;
	}

	/**
	 * Returns deploy host URL.
	 * For cloud mode, resolves to the cloud URL (same logic as ConnectionManager).
	 * For on-prem, returns the deploy-specific host URL.
	 */
	protected override getEffectiveHostUrl(): string {
		const config = this.configManager.getConfig();
		const mode = config.deployTargetMode;
		if (mode === 'cloud') {
			return config.env.RR_CLOUD_URL || process.env.RR_CLOUD_URL || 'https://cloud.rocketride.ai';
		}
		if (mode === 'docker' || mode === 'service') {
			return 'http://localhost:5565';
		}
		return config.deployHostUrl;
	}

	/**
	 * Returns deploy API key for on-prem deploy targets.
	 */
	protected override getEffectiveApiKey(): string {
		return this.configManager.getConfig().deployApiKey;
	}
}
