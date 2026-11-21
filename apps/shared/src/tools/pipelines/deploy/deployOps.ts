// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEPLOY OPS — the pipeline page's deploy/deployment surface, realm-side
// =============================================================================
//
// The port of the extension host's DeployLifecycle fetch/mutation layer onto
// the realm client's `client.deploy.*` surface (its requests ride the shell
// bus): every call ANSWERS ITS CALLER (the old deploy:data push settled every
// outstanding waiter at once; the old deployment:load was an echo-routed
// push). The mapping layer
// (deployMapping.ts) is pure and identity-decoupled, so the only host
// residue left is publish (it needs the TextDocument — host.pipeline.*).
//
// Team identity: a row's `teamId` is its audience as the server composed it
// (plan 2.5) and goes back to the server unchanged — the deploy verbs, the
// run-log reader, the task monitor and the token lookup all take it. Rows
// carry their `rung` and `handle` too, so nothing here parses an audience.
//
// Store review (plan 10.1): a pipe walks the app's review ladder, so its
// review state and its submit/withdraw verbs are the App Builder's
// (`rrext_deploy_app` reads pipe artifacts since C.17), addressed by the
// pipe's registry name `developerId.pipeId`.
// =============================================================================

import { ConnectionManager } from 'shell';
import type { DeployArtifact, DeployHistoryEntry, RocketRideClient } from 'rocketride';
import { registryIdOf, resolveDeployTeams } from 'rocketride';
import { mapVersionCards, mapHistoryRows, mapTeamDeploymentRows, mapScheduleRows, mapDeploymentInfo, withReviewStates } from './deployMapping';
import type { DeployTeamRefDTO, DeployVersionCardDTO, TeamDeploymentRowDTO, DeploymentLoadPayload } from './deployTypes';

const cm = (): ConnectionManager => ConnectionManager.getInstance();

/** The realm's connected client, or throws the standard message. */
function needClient(): RocketRideClient {
	const client = cm().getClient();
	if (!client || !cm().isConnected()) throw new Error('Not connected to server');
	return client;
}

/**
 * The pipe's registry name for a verb addressed by it, or the claim message.
 *
 * @param projectId - The pipe's short id.
 * @returns `developerId.pipeId`.
 * @throws Error when the organization has no developer id yet.
 */
function needRegistryId(projectId: string): string {
	const id = registryIdOf(projectId, cm().getAccountInfo()?.organization?.developerId);
	if (!id) throw new Error("A pipeline's store review needs your organization's developer id, and it has none yet. Claim one in the banner above.");
	return id;
}

/**
 * The version rail's review states. A rail that cannot be read leaves the
 * cards without a state (no badge, no review verb) instead of failing the
 * whole DEPLOY snapshot.
 *
 * @param client - The realm's connected client.
 * @param registryId - The pipe's registry name ('' = unknown).
 * @returns The rail rows, or none.
 */
async function reviewRailOf(client: RocketRideClient, registryId: string): Promise<Array<{ registryVersion: number; state?: string }>> {
	if (!registryId) return [];
	try {
		return await client.listDeployments(registryId);
	} catch (err) {
		console.log('[deployOps] review states unavailable:', err);
		return [];
	}
}

// =============================================================================
// THE LIFECYCLE SNAPSHOT (the old deploy:fetch → deploy:data)
// =============================================================================

/** What the DEPLOY page renders: registry versions + team rows + roster. */
export interface IDeployLifecycleSnapshot {
	versions: DeployVersionCardDTO[];
	deployments: TeamDeploymentRowDTO[];
	teams: DeployTeamRefDTO[];
}

/**
 * Fetches this project's deploy lifecycle. A project that was never
 * published has no registry — the snapshot degrades to empty arrays (with
 * the identity-derived roster kept so Publish still offers targets), ending
 * the page's loading state rather than erroring.
 *
 * @param projectId - The editor's project identity (undefined = unsaved).
 * @returns The snapshot.
 */
export async function fetchDeployLifecycle(projectId: string | undefined): Promise<IDeployLifecycleSnapshot> {
	const bus = cm();
	if (!projectId || !bus.isConnected()) return { versions: [], deployments: [], teams: [] };
	const info = bus.getAccountInfo();
	try {
		const client = needClient();
		// Rows carry the registry name (`developerId.pipeId`); the editor
		// knows the file's short id, so the match is on the composed name.
		const registryId = registryIdOf(projectId, info?.organization?.developerId);
		const [versions, list, rail] = await Promise.all([
			client.deploy.versions(projectId),
			client.deploy.list(),
			// The review state per version rides the rail, not the registry rows.
			reviewRailOf(client, registryId),
		]);
		const deploymentRows = list.rows ?? [];
		const teams = resolveDeployTeams({ getAccountInfo: () => info }, deploymentRows);
		return {
			versions: withReviewStates(mapVersionCards((versions.rows ?? []) as DeployArtifact[]), rail),
			deployments: mapTeamDeploymentRows(deploymentRows, registryId, teams),
			teams,
		};
	} catch {
		return { versions: [], deployments: [], teams: resolveDeployTeams({ getAccountInfo: () => info }, []) };
	}
}

// =============================================================================
// THE DEPLOYMENT RECORD (the old deployment:fetch → deployment:load)
// =============================================================================

/**
 * Fetches one team deployment's full record — get → artifact →
 * history(teamId) → versions → schedule previews through THE single cron
 * evaluator → live-run scan — exactly the host's old 6-step fetch, but the
 * result ANSWERS THE CALLER (no echo-routed push, no stale-record guard
 * needed beyond the caller's own sequencing).
 *
 * @param projectId - The deployed project.
 * @param teamId - The row's `teamId` the drawer opened with (its audience),
 *                 passed to the server unchanged.
 * @param sourceId - The focused source (the record identity), if any.
 * @returns The drawer payload (teamId NOT included — the caller owns it).
 */
export async function fetchDeployment(projectId: string, teamId: string, sourceId?: string): Promise<DeploymentLoadPayload> {
	const bus = cm();
	const client = needClient();

	// Step 1: the deployment record (version pointer, state, schedules).
	const dep = await client.deploy.get(projectId, teamId);

	// Step 2: the immutable artifact this team runs (readonly DESIGN).
	const pipeline: Record<string, unknown> = typeof dep.version === 'number' ? ((await client.deploy.artifact(projectId, dep.version)) as unknown as Record<string, unknown>) : {};

	// Step 3: this team's audit trail + the registry version picker.
	const [history, versions]: [{ rows?: DeployHistoryEntry[] }, { rows?: DeployArtifact[] }] = await Promise.all([
		client.deploy.history(projectId, { teamId }),
		client.deploy.versions(projectId),
	]);

	// Step 4: next occurrence through THE single evaluator (never parse cron
	// client-side): the FOCUSED source's schedule, or — for the TEAM record —
	// the first armed schedule across every source.
	let nextRun: DeploymentLoadPayload['nextRun'];
	const allScheds = (dep.schedules ?? {}) as Record<string, { cron?: string; paused?: boolean }>;
	const sched = sourceId ? allScheds[sourceId] : undefined;
	const armed = sourceId ? (sched?.cron && !sched.paused ? ([sourceId, sched] as const) : undefined) : Object.entries(allScheds).find(([, entry]) => entry.cron && !entry.paused);
	if (armed?.[1].cron && dep.state === 'enabled') {
		const preview: { valid?: boolean; next?: number[] } = await client.deploy.preview(armed[1].cron, 1);
		const firstAt = preview.valid ? preview.next?.[0] : undefined;
		if (typeof firstAt === 'number') nextRun = { at: firstAt, sourceId: armed[0], cron: armed[1].cron };
	}

	// TEAM record: every armed schedule's next occurrence (the status grid's
	// Next-run column), previews fanned out concurrently.
	const nextRuns: Record<string, number> = {};
	if (!sourceId && dep.state === 'enabled') {
		const armedSources = Object.entries(allScheds).filter(([, entry]) => entry.cron && !entry.paused);
		const previews = await Promise.all(
			armedSources.map(async ([sid, entry]) => {
				try {
					const preview: { valid?: boolean; next?: number[] } = await client.deploy.preview(entry.cron as string, 1);
					return [sid, preview.valid ? preview.next?.[0] : undefined] as const;
				} catch {
					// An unpreviewable cron just leaves the cell empty.
					return [sid, undefined] as const;
				}
			})
		);
		for (const [sid, firstAt] of previews) {
			if (typeof firstAt === 'number') nextRuns[sid] = firstAt;
		}
	}

	// Step 5: which sources have a LIVE run right now — server task registry.
	// A deploy run's task row carries the audience of the publication it
	// serves through: the same string as this deployment's teamId, for a team,
	// a personal space and the store alike.
	const tasks = await client.call<{ tasks?: Array<{ source?: string; audience?: string; runKind?: string; pipeline?: { project_id?: string } }> }>('rrext_get_tasks');
	const runningSources: Record<string, boolean> = {};
	for (const t of tasks.tasks ?? []) {
		if (t.pipeline?.project_id !== projectId || !t.source) continue;
		// runKind too: an ordinary pipeline run on the same
		// project/source must not mark the source as deploy-running.
		const matches = t.audience === teamId && t.runKind === 'deploy';
		if (matches) runningSources[t.source] = true;
	}

	// Step 6: resolve teams (names + control) and map into view models.
	const info = bus.getAccountInfo();
	const teams = resolveDeployTeams({ getAccountInfo: () => info }, [dep]);
	const components = Array.isArray(pipeline.components) ? (pipeline.components as Array<{ id?: string; name?: string }>) : [];
	const sourceName = sourceId ? components.find((c) => c.id === sourceId)?.name || sourceId : undefined;
	return {
		teamName: teams.find((t) => t.id === teamId)?.name ?? (dep.handle || teamId),
		deployment: mapDeploymentInfo(dep, projectId),
		pipeline,
		servicesJson: ((bus.getCachedServices() as { services?: Record<string, unknown> } | null)?.services ?? {}) as Record<string, unknown>,
		...(sourceId ? { sourceId } : {}),
		...(sourceName ? { sourceName } : {}),
		...(sched ? { sourcePaused: sched.paused === true } : {}),
		...(sourceId
			? {
					sourceConfig: {
						traceLevel: ((sched as { traceLevel?: string } | undefined)?.traceLevel ?? null) as 'none' | 'metadata' | 'summary' | 'full' | null,
						debugOut: (sched as { debugOut?: boolean } | undefined)?.debugOut === true,
					},
				}
			: {}),
		schedules: mapScheduleRows(pipeline, dep),
		...(Object.keys(nextRuns).length > 0 ? { nextRuns } : {}),
		versions: mapVersionCards(versions.rows ?? []),
		history: mapHistoryRows(history.rows ?? []),
		...(nextRun ? { nextRun } : {}),
		runningSources,
		// The caller's own space is always theirs to control; a team by its roster entry
		canControl: dep.rung === 'me' || (teams.find((t) => t.id === teamId)?.canControl ?? false),
		isConnected: bus.isConnected(),
	};
}

// =============================================================================
// MUTATIONS (the old deployment:* verbs — each answers its caller)
// =============================================================================

/** The deployment mutations the drawer drives. Each resolves on the server's
 *  ack; the CALLER drives any refresh afterwards (it owns the focused
 *  source), exactly the old contract. */
export const deploymentActions = {
	setDisabled: (projectId: string, teamId: string, disabled: boolean) => (disabled ? needClient().deploy.disable(projectId, teamId) : needClient().deploy.enable(projectId, teamId)),
	deployVersion: (projectId: string, teamId: string, version: number) => needClient().deploy.deploy(projectId, version, teamId),
	remove: (projectId: string, teamId: string) => needClient().deploy.remove(projectId, teamId),
	/** Delete one deployed version from the server (plan 2.3); the server
	 *  refuses by name while a rung pins it, it is in review, or it builds. */
	deleteVersion: (projectId: string, version: number) => needClient().deploy.delete(projectId, version),
	/** Submit one deployed version for store review ('private' → 'submit'):
	 *  the App Builder's verb on the pipe's registry name. The server takes
	 *  only the newest version that did not fail. */
	submitForReview: (projectId: string, version: number) => needClient().submitApp(needRegistryId(projectId), version),
	/** Withdraw a pending review ('submit' → 'private'), the developer's own
	 *  cancel; the version is a draft again. */
	withdrawReview: (projectId: string, version: number) => needClient().withdrawApp(needRegistryId(projectId), version),
	runSource: (projectId: string, teamId: string, sourceId: string) => needClient().deploy.run(projectId, sourceId, teamId),
	stopSource: async (projectId: string, teamId: string, sourceId: string) => {
		// Existing task machinery: resolve the live task, terminate it. teamId
		// (the row's audience) scopes the lookup to that deployment's run.
		const client = needClient();
		const token = await client.getTaskToken({ projectId, source: sourceId, teamId });
		if (token) await client.terminate(token);
	},
	setSchedule: (projectId: string, teamId: string, sourceId: string, cron: string | null, ttl?: number | null) => needClient().deploy.setSchedule(projectId, sourceId, cron, teamId, { ...(ttl !== null && ttl !== undefined ? { ttl } : {}) }),
	setSourceConfig: (projectId: string, teamId: string, sourceId: string, traceLevel: string | null, debugOut: boolean) => needClient().deploy.setSourceConfig(projectId, sourceId, teamId, { ...(traceLevel ? { traceLevel: traceLevel as 'none' | 'metadata' | 'summary' | 'full' } : {}), debugOut }),
	setSchedulePaused: (projectId: string, teamId: string, sourceId: string, paused: boolean) => (paused ? needClient().deploy.pauseSchedule(projectId, sourceId, teamId) : needClient().deploy.resumeSchedule(projectId, sourceId, teamId)),
	/** Cron preview — THE single evaluator; teamId-free. */
	preview: (cron: string, count: number) => needClient().deploy.preview(cron, count),
	/** Validation passthrough (readonly canvas still validates). CONTRACT:
	 *  failures render as a CLEAN canvas — never an error. */
	validate: async (pipeline: Record<string, unknown>): Promise<{ errors: unknown[]; warnings: unknown[] }> => {
		try {
			return (await needClient().validate({ pipeline })) as unknown as { errors: unknown[]; warnings: unknown[] };
		} catch {
			return { errors: [], warnings: [] };
		}
	},
	/** Fetches one immutable artifact (the version drawer). */
	artifact: (projectId: string, version: number) => needClient().deploy.artifact(projectId, version) as unknown as Promise<Record<string, unknown>>,
};
