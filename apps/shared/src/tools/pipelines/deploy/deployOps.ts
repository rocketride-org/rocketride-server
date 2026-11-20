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
// Team identity: rows carry their RAW owner key (`user~{uid}` for personal
// space); the WIRE only accepts '@me' for the caller's own space —
// wireTeamIdOf translates once at this boundary, exactly as the host did.
// =============================================================================

import { ConnectionManager } from 'shell';
import type { DeployArtifact, DeployHistoryEntry, RocketRideClient } from 'rocketride';
import { resolveDeployTeams, teamNameOf, wireTeamIdOf } from 'rocketride';
import { mapVersionCards, mapHistoryRows, mapTeamDeploymentRows, mapScheduleRows, mapDeploymentInfo } from './deployMapping';
import type { DeployTeamRefDTO, DeployVersionCardDTO, TeamDeploymentRowDTO, DeploymentLoadPayload } from './deployTypes';

const cm = (): ConnectionManager => ConnectionManager.getInstance();

/** The realm's connected client, or throws the standard message. */
function needClient(): RocketRideClient {
	const client = cm().getClient();
	if (!client || !cm().isConnected()) throw new Error('Not connected to server');
	return client;
}

/** The caller's uid off the mirrored identity ('' pre-auth). */
function ownUid(): string {
	return cm().getAccountInfo()?.userId ?? '';
}

/** RAW row id → the wire id the deploy API accepts. */
export function toWireTeamId(rawTeamId: string): string {
	return wireTeamIdOf(rawTeamId, ownUid());
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
		const [versions, list] = await Promise.all([
			client.deploy.versions(projectId),
			client.deploy.list(),
		]);
		const deploymentRows = list.rows ?? [];
		const teams = resolveDeployTeams({ getAccountInfo: () => info }, deploymentRows);
		return {
			versions: mapVersionCards((versions.rows ?? []) as DeployArtifact[]),
			deployments: mapTeamDeploymentRows(deploymentRows, projectId, teams, info?.userId ?? ''),
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
 * @param rawTeamId - The RAW row id the drawer opened with (`user~{uid}`
 *                    for personal space) — translated to the wire id here.
 * @param sourceId - The focused source (the record identity), if any.
 * @returns The drawer payload (teamId NOT included — the caller owns it).
 */
export async function fetchDeployment(projectId: string, rawTeamId: string, sourceId?: string): Promise<DeploymentLoadPayload> {
	const bus = cm();
	const teamId = toWireTeamId(rawTeamId);
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
	// A TEAM deployment matches on the descriptor's teamId; a PERSONAL (@me)
	// deployment matches on the trusted owner scope instead (its row carries
	// the billing team, never the wire '@me').
	const tasks = await client.call<{ tasks?: Array<{ source?: string; teamId?: string; runKind?: string; ownerKind?: string; ownerId?: string; pipeline?: { project_id?: string } }> }>('rrext_get_tasks');
	const personalUid = rawTeamId.startsWith('user~') ? rawTeamId.slice('user~'.length) : undefined;
	const runningSources: Record<string, boolean> = {};
	for (const t of tasks.tasks ?? []) {
		if (t.pipeline?.project_id !== projectId || !t.source) continue;
		// runKind on BOTH branches: a team's ordinary pipeline run on the same
		// project/source must not mark the source as deploy-running.
		const matches = personalUid ? t.ownerKind === 'user' && t.ownerId === personalUid && t.runKind === 'deploy' : t.teamId === teamId && t.runKind === 'deploy';
		if (matches) runningSources[t.source] = true;
	}

	// Step 6: resolve teams (names + control) and map into view models.
	const info = bus.getAccountInfo();
	const teams = resolveDeployTeams({ getAccountInfo: () => info }, [dep]);
	const components = Array.isArray(pipeline.components) ? (pipeline.components as Array<{ id?: string; name?: string }>) : [];
	const sourceName = sourceId ? components.find((c) => c.id === sourceId)?.name || sourceId : undefined;
	return {
		teamName: teamNameOf(teams, teamId),
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
		history: mapHistoryRows(history.rows ?? [], teams, info?.userId ?? ''),
		...(nextRun ? { nextRun } : {}),
		runningSources,
		canControl: teams.find((t) => t.id === teamId)?.canControl ?? false,
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
	setDisabled: (projectId: string, rawTeamId: string, disabled: boolean) => (disabled ? needClient().deploy.disable(projectId, toWireTeamId(rawTeamId)) : needClient().deploy.enable(projectId, toWireTeamId(rawTeamId))),
	deployVersion: (projectId: string, rawTeamId: string, version: number) => needClient().deploy.deploy(projectId, version, toWireTeamId(rawTeamId)),
	remove: (projectId: string, rawTeamId: string) => needClient().deploy.remove(projectId, toWireTeamId(rawTeamId)),
	runSource: (projectId: string, rawTeamId: string, sourceId: string) => needClient().deploy.run(projectId, sourceId, toWireTeamId(rawTeamId)),
	stopSource: async (projectId: string, rawTeamId: string, sourceId: string) => {
		// Existing task machinery: resolve the live task, terminate it. teamId
		// scopes the lookup to the TEAM's deploy run.
		const client = needClient();
		const teamId = toWireTeamId(rawTeamId);
		const token = await client.getTaskToken({ projectId, source: sourceId, teamId });
		if (token) await client.terminate(token);
	},
	setSchedule: (projectId: string, rawTeamId: string, sourceId: string, cron: string | null, ttl?: number | null) => needClient().deploy.setSchedule(projectId, sourceId, cron, toWireTeamId(rawTeamId), { ...(ttl !== null && ttl !== undefined ? { ttl } : {}) }),
	setSourceConfig: (projectId: string, rawTeamId: string, sourceId: string, traceLevel: string | null, debugOut: boolean) => needClient().deploy.setSourceConfig(projectId, sourceId, toWireTeamId(rawTeamId), { ...(traceLevel ? { traceLevel: traceLevel as 'none' | 'metadata' | 'summary' | 'full' } : {}), debugOut }),
	setSchedulePaused: (projectId: string, rawTeamId: string, sourceId: string, paused: boolean) => (paused ? needClient().deploy.pauseSchedule(projectId, sourceId, toWireTeamId(rawTeamId)) : needClient().deploy.resumeSchedule(projectId, sourceId, toWireTeamId(rawTeamId))),
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
