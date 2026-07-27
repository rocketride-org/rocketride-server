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
 * Teams-as-environments deployments via the `rrext_deploy` DAP command
 * (dispatched by `subcommand`) over the existing WebSocket connection:
 *
 * - `publish` snapshots a pipeline as an IMMUTABLE, sha256-locked artifact
 *   version in the org registry.
 * - `deploy` points a TEAM at a published version. Teams ARE the
 *   environments (Staging, Production, ...): promotion and rollback are this
 *   same pointer move aimed at a different version or team. Deploy targets
 *   are always explicit — there is deliberately no default-team fallback.
 * - Every publish and pointer change lands in an immutable audit history.
 * - `list`/`versions`/`history` return the standard list envelope
 *   (`{rows, total, page, pageSize}`) with page/search/filter/sort params.
 */

import type { RocketRideClient } from './client.js';
import type { DeployHistoryEntry, DeployListEnvelope, DeployListParams, Deployment, DeployArtifact, PipelineConfig, PublishResult, SchedulePreview } from './types/deploy.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Folds the standard list-API params into wire arguments.
 *
 * Only supplied values are sent — the server applies its own defaults
 * (page 1, clamped page size) to whatever is absent. `pageSize` maps to the
 * wire's `page_size` key.
 *
 * @param params - The caller's list params.
 * @returns Wire-shaped arguments to spread into the call.
 */
function listArgs(params: DeployListParams): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (params.page !== undefined) args.page = params.page;
	if (params.pageSize !== undefined) args.page_size = params.pageSize;
	if (params.search !== undefined) args.search = params.search;
	if (params.filters !== undefined) args.filters = params.filters;
	if (params.sort !== undefined) args.sort = params.sort;
	return args;
}

// =============================================================================
// DEPLOY API CLASS
// =============================================================================

/**
 * Typed wrapper around the `rrext_deploy` DAP command and its subcommands.
 *
 * Accessed via `client.deploy` — not instantiated directly. All methods
 * delegate to {@link RocketRideClient.call} which handles envelope
 * unwrapping and error propagation.
 */
export class DeployApi {
	/** @param client - The parent RocketRideClient that owns this namespace. */
	constructor(private client: RocketRideClient) {}

	// =========================================================================
	// PUBLISH — immutable artifact into the org registry
	// =========================================================================

	/**
	 * Publishes a pipeline as the next immutable registry version.
	 *
	 * The artifact is sha256-locked: what was published is provably what
	 * runs. Publishing alone puts nothing live — point a team at the version
	 * with {@link deploy} (or pass `deployTo` to do both in one step, the
	 * small-team convenience).
	 *
	 * @param pipeline - The full pipeline definition to snapshot.
	 * @param options - Optional publish options.
	 * @param options.comment - "What changed" note kept in the registry.
	 * @param options.deployTo - Team id to deploy the new version to
	 *   immediately (one-step publish+deploy).
	 * @returns The artifact entry, plus the deployment when `deployTo` was given.
	 */
	async publish(pipeline: PipelineConfig, options: { comment?: string; deployTo?: string } = {}): Promise<PublishResult> {
		return this.client.call<PublishResult>('rrext_deploy', {
			subcommand: 'publish',
			pipeline,
			...(options.comment !== undefined && { comment: options.comment }),
			...(options.deployTo !== undefined && { deployTo: options.deployTo }),
		});
	}

	// =========================================================================
	// DEPLOY — point a team at a version (promotion and rollback alike)
	// =========================================================================

	/**
	 * Points a team at a published version.
	 *
	 * Promotion (Staging → Production) and rollback (v3 → v2) are both this
	 * call — the team's pointer moves, nothing else changes. The team is
	 * always explicit; requires `task.control` on it.
	 *
	 * @param projectId - The project whose artifact to deploy.
	 * @param version - The registry version to point the team at.
	 * @param teamId - The target team (the environment).
	 * @returns The updated deployment record, registry-joined.
	 */
	async deploy(projectId: string, version: number, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy', {
			subcommand: 'deploy',
			projectId,
			version,
			teamId,
		});
	}

	// =========================================================================
	// READS — standard list envelopes
	// =========================================================================

	/**
	 * Deployments visible to the caller, as the standard list envelope.
	 *
	 * @param params - Optional team scope + list-API params.
	 * @param params.teamId - Restrict to one team; omitted = every team the
	 *   caller can monitor.
	 * @returns `{rows, total, page, pageSize}` of {@link Deployment} rows.
	 */
	async list(params: DeployListParams & { teamId?: string } = {}): Promise<DeployListEnvelope<Deployment>> {
		return this.client.call<DeployListEnvelope<Deployment>>('rrext_deploy', {
			subcommand: 'list',
			...(params.teamId !== undefined && { teamId: params.teamId }),
			...listArgs(params),
		});
	}

	/**
	 * One team's deployment of a project, registry-joined.
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to fetch.
	 * @returns The deployment record (version, state, schedules, actors).
	 */
	async get(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy', {
			subcommand: 'get',
			projectId,
			teamId,
		});
	}

	/**
	 * The org-registry versions of a project (the version strip), newest
	 * first, as the standard list envelope.
	 *
	 * @param projectId - The project whose registry to read.
	 * @param params - Optional list-API params.
	 * @returns `{rows, total, page, pageSize}` of {@link DeployArtifact} rows.
	 */
	async versions(projectId: string, params: DeployListParams = {}): Promise<DeployListEnvelope<DeployArtifact>> {
		return this.client.call<DeployListEnvelope<DeployArtifact>>('rrext_deploy', {
			subcommand: 'versions',
			projectId,
			...listArgs(params),
		});
	}

	/**
	 * The immutable audit trail of a project, newest first, as the standard
	 * list envelope.
	 *
	 * The trail is unbounded by design (who published what when, who put
	 * which version live where) — the server pages it; rows carry `seq`, the
	 * stable append-order key, as their identity.
	 *
	 * @param projectId - The project whose trail to read.
	 * @param params - Optional team scope + list-API params (`filters.at__gte`
	 *   / `at__lte` take epoch seconds).
	 * @param params.teamId - Restrict to one team's pointer changes
	 *   (org-wide publish rows always ride along).
	 * @returns `{rows, total, page, pageSize}` of {@link DeployHistoryEntry} rows.
	 */
	async history(projectId: string, params: DeployListParams & { teamId?: string } = {}): Promise<DeployListEnvelope<DeployHistoryEntry>> {
		return this.client.call<DeployListEnvelope<DeployHistoryEntry>>('rrext_deploy', {
			subcommand: 'history',
			projectId,
			...(params.teamId !== undefined && { teamId: params.teamId }),
			...listArgs(params),
		});
	}

	// =========================================================================
	// STATE — pause / resume / soft remove
	// =========================================================================

	/**
	 * Pauses one team's deployment (schedules stop firing).
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to pause.
	 * @returns The updated deployment record.
	 */
	async pause(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy', {
			subcommand: 'pause',
			projectId,
			teamId,
		});
	}

	/**
	 * Resumes one team's paused deployment.
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to resume.
	 * @returns The updated deployment record.
	 */
	async resume(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy', {
			subcommand: 'resume',
			projectId,
			teamId,
		});
	}

	/**
	 * Soft-removes one team's deployment.
	 *
	 * Listings hide it; the audit history and every registry artifact
	 * survive forever (the enterprise requirement). Re-deploying any version
	 * revives it.
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to remove.
	 * @returns The final deployment record (state `removed`).
	 */
	async remove(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy', {
			subcommand: 'remove',
			projectId,
			teamId,
		});
	}

	// =========================================================================
	// SCHEDULES
	// =========================================================================

	/**
	 * Sets (or clears) one source's schedule on a team deployment.
	 *
	 * @param projectId - The project.
	 * @param sourceId - The pipeline source the schedule fires.
	 * @param schedule - 5-field cron expression; `null` or `'manual'` clears
	 *   the schedule.
	 * @param teamId - The team whose deployment to schedule.
	 * @param options - Optional schedule options.
	 * @param options.enabled - Set false to keep the cron but stop it firing.
	 * @returns The updated deployment record.
	 */
	async setSchedule(projectId: string, sourceId: string, schedule: string | null, teamId: string, options: { enabled?: boolean } = {}): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy', {
			subcommand: 'schedule_set',
			projectId,
			sourceId,
			teamId,
			enabled: options.enabled ?? true,
			...(schedule !== null && { schedule }),
		});
	}

	/**
	 * Validates a schedule and returns its next occurrences.
	 *
	 * THE single cron evaluator: panel validation, "next:" lines, and DVR
	 * ghost tracks all render from this — nothing client-side parses cron,
	 * so a preview can never disagree with what the scheduler fires.
	 *
	 * @param schedule - 5-field cron expression (or `'manual'`).
	 * @param count - How many upcoming occurrences to return (server-capped).
	 * @returns Validity plus the next occurrence timestamps.
	 */
	async preview(schedule: string, count?: number): Promise<SchedulePreview> {
		return this.client.call<SchedulePreview>('rrext_deploy', {
			subcommand: 'preview',
			schedule,
			...(count !== undefined && { count }),
		});
	}
}
