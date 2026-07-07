/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Deploy API namespace for the RocketRide TypeScript SDK.
 *
 * Provides typed methods for managing server-side pipeline deployments via
 * `rrext_deploy_*` DAP commands over the existing WebSocket connection.
 */

import type { RocketRideClient } from './client.js';
import type { DeploymentRecord, PipelineConfig } from './types/deploy.js';

// =============================================================================
// DEPLOY API CLASS
// =============================================================================

/**
 * Typed wrapper around the `rrext_deploy_*` DAP commands.
 *
 * Accessed via `client.deploy` — not instantiated directly. All methods
 * delegate to {@link RocketRideClient.call} which handles envelope
 * unwrapping and error propagation.
 */
export class DeployApi {
	/** @param client - The parent RocketRideClient that owns this namespace. */
	constructor(private client: RocketRideClient) {}

	// =========================================================================
	// DEPLOYMENTS
	// =========================================================================

	/**
	 * Deploys a pipeline to the server and activates it.
	 *
	 * @param pipeline - The pipeline definition to deploy.
	 * @param options - Optional deploy options.
	 * @param options.schedule - Cron expression or `"manual"`. Defaults to `"manual"` if omitted.
	 * @returns The created deployment record.
	 */
	async add(
		pipeline: PipelineConfig,
		options: { schedule?: string } = {},
	): Promise<DeploymentRecord> {
		const { schedule } = options;
		return this.client.call<DeploymentRecord>('rrext_deploy_add', {
			pipeline,
			...(schedule !== undefined && { schedule }),
		});
	}

	/**
	 * Undeploys and removes a pipeline from the server.
	 *
	 * @param projectId - Project ID of the deployment to remove.
	 */
	async remove(projectId: string): Promise<void> {
		await this.client.call('rrext_deploy_remove', { projectId });
	}

	/**
	 * Returns the authenticated user's deployments with their status and schedule config.
	 *
	 * @returns Array of deployment summary records.
	 */
	async list(): Promise<DeploymentRecord[]> {
		const body = await this.client.call('rrext_deploy_list');
		return body.deployments ?? [];
	}

	/**
	 * Gets detailed status of a specific deployment.
	 *
	 * @param projectId - Project ID of the deployment to query.
	 * @returns The deployment record including state, schedule, and timestamps.
	 */
	async status(projectId: string): Promise<DeploymentRecord> {
		return this.client.call<DeploymentRecord>('rrext_deploy_status', { projectId });
	}

	/**
	 * Modifies the schedule or pipeline config for an existing deployment.
	 *
	 * Both `pipeline` and `schedule` are optional — omit a parameter to leave it unchanged.
	 *
	 * @param projectId - Project ID of the deployment to update.
	 * @param options - Optional update options.
	 * @param options.pipeline - Replacement pipeline definition, or omit to leave unchanged.
	 * @param options.schedule - Replacement cron expression or `"manual"`, or omit to leave unchanged.
	 */
	async update(
		projectId: string,
		options: { pipeline?: PipelineConfig; schedule?: string } = {},
	): Promise<void> {
		const { pipeline, schedule } = options;
		await this.client.call('rrext_deploy_update', {
			projectId,
			...(pipeline !== undefined && { pipeline }),
			...(schedule !== undefined && { schedule }),
		});
	}
}
