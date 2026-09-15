// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Host-side SDK-to-view-model mapping for the deploy surfaces.
 *
 * The extension host fetches through `client.deploy.*` and maps the SDK rows
 * into the serialisable DTOs of `providers/types/deployTypes.ts` BEFORE they
 * cross postMessage — the webviews render view models only, exactly like the
 * rocket-ui hosts (DeployLifecycleProvider / DeploymentPage / useDeployments),
 * whose mapping logic this module mirrors line-for-line.
 */

import type { RocketRideClient, Deployment, DeployArtifact, DeployHistoryEntry } from 'rocketride';
import type { DeployTeamRefDTO, DeployVersionCardDTO, TeamDeploymentRowDTO, DeployHistoryRowDTO, DeployScheduleRowDTO, DeploymentInfoDTO } from '../../providers/types/deployTypes';

// =============================================================================
// TEAM RESOLUTION
// =============================================================================

/**
 * Resolves the caller's team roster (names + control rights) from the
 * authenticated identity, mirroring rocket-ui's useDeployments:
 *
 * - org.admin (and sys.admin) implies the FULL team permission set — the
 *   server resolver's documented expansion; per-team rows only carry
 *   explicit task.* grants for regular members.
 * - Rosterless identities (the OSS single-team server) derive refs from the
 *   deployment rows with control assumed — the server enforces the real
 *   permission on every call.
 *
 * @param client - The connected SDK client (its cached ConnectResult is read).
 * @param deployments - Deployment rows used as the rosterless fallback.
 * @returns Team refs with resolved display names and control rights.
 */
export function resolveDeployTeams(client: RocketRideClient | null | undefined, deployments: Deployment[]): DeployTeamRefDTO[] {
	// Step 1: read the cached identity from the client (null pre-auth).
	const info = client?.getAccountInfo?.();
	const org = info?.organization;

	// Step 2: the personal (@me) target — every authenticated user can point
	// their own space (the server applies no team permission to it; the @me
	// PUBLISH stamps the dev team or refuses). Listed first: it exists even
	// for a user with zero team memberships.
	const me: DeployTeamRefDTO[] = info?.userId ? [{ id: '@me', name: 'Me', canControl: true }] : [];

	// Step 3: admin expansion — org.admin / sys.admin controls every team.
	const isAdmin = (org?.permissions ?? []).includes('org.admin') || (info?.sysPermissions ?? []).includes('sys.admin');

	// Step 4: prefer the identity's team roster when one exists.
	const orgTeams = org?.teams;
	if (Array.isArray(orgTeams) && orgTeams.length > 0) {
		return [...me, ...orgTeams.filter((t) => t.id).map((t) => ({ id: t.id, name: t.name || t.id, canControl: isAdmin || (t.permissions ?? []).includes('task.control') }))];
	}

	// Step 5: OSS / rosterless identity — derive refs from the deployment rows
	// so the surfaces still render; the server enforces real permissions.
	// Personal (user~) rows never become roster targets — '@me' covers the
	// caller's own space and foreign spaces are not addressable.
	const seen = new Map<string, DeployTeamRefDTO>();
	for (const dep of deployments) {
		if (dep.teamId && !dep.teamId.startsWith('user~') && !seen.has(dep.teamId)) {
			seen.set(dep.teamId, { id: dep.teamId, name: dep.teamId, canControl: true });
		}
	}
	return [...me, ...seen.values()];
}

/**
 * Resolves a team id to its display name, falling back to the id.
 * Personal (``user~``) owner keys render as "Me" for the caller's own
 * space and "Personal" for another user's (admin visibility) — the raw
 * guid never reaches a label.
 *
 * @param teams - The resolved team refs.
 * @param teamId - The team id (or owner key) to resolve.
 * @param ownUserId - The caller's user id ('' when unknown).
 * @returns The display name, or the id when unknown.
 */
export function teamNameOf(teams: DeployTeamRefDTO[], teamId: string, ownUserId = ''): string {
	if (teamId.startsWith('user~')) {
		return ownUserId && teamId === `user~${ownUserId}` ? 'Me' : 'Personal';
	}
	return teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/**
 * Translates a row's owner key into the ADDRESSABLE team ref for API calls:
 * the caller's own ``user~{uid}`` row is addressed as ``'@me'`` (the server
 * never accepts raw owner keys); everything else passes through.
 *
 * @param teamId - The row's team id / owner key.
 * @param ownUserId - The caller's user id ('' when unknown).
 * @returns The teamId to put on the wire.
 */
export function wireTeamIdOf(teamId: string, ownUserId: string): string {
	return ownUserId && teamId === `user~${ownUserId}` ? '@me' : teamId;
}

// =============================================================================
// REGISTRY MAPPERS
// =============================================================================

/**
 * Maps registry artifact rows into version-strip cards.
 *
 * @param rows - `client.deploy.versions()` rows, newest first.
 * @returns Version cards for the strip / pickers.
 */
export function mapVersionCards(rows: DeployArtifact[]): DeployVersionCardDTO[] {
	return rows.map((v) => ({
		version: v.version ?? 0,
		sha256: v.sha256 ?? '',
		publishedAt: v.publishedAt ?? 0,
		publishedBy: v.publishedBy?.display || v.publishedBy?.userId || '',
		...(v.comment ? { comment: v.comment } : {}),
	}));
}

/**
 * Maps audit-trail rows into history rows with resolved team names.
 *
 * @param rows - `client.deploy.history()` rows, newest first.
 * @param teams - The resolved team refs (name lookup).
 * @param ownUserId - The caller's user id (personal-row labeling).
 * @returns History rows for the merged audit grid.
 */
export function mapHistoryRows(rows: DeployHistoryEntry[], teams: DeployTeamRefDTO[], ownUserId = ''): DeployHistoryRowDTO[] {
	return rows.map((row) => ({
		seq: row.seq ?? 0,
		at: row.at ?? 0,
		action: (row.action ?? 'deploy') as DeployHistoryRowDTO['action'],
		teamId: row.teamId ?? '',
		teamName: row.teamId ? teamNameOf(teams, row.teamId, ownUserId) : '',
		version: row.version ?? 0,
		actor: row.actor?.display || row.actor?.userId || '',
	}));
}

// =============================================================================
// DEPLOYMENT MAPPERS
// =============================================================================

/**
 * Maps deployment rows into the file view's "where live" facts for ONE
 * project — removed rows are hidden. RAW facts only: source names are
 * resolved by the shared ProjectView against the pipeline it holds.
 *
 * @param deployments - `client.deploy.list()` rows (all projects).
 * @param projectId - The project whose deployments to keep.
 * @param teams - The resolved team refs (name lookup).
 * @param ownUserId - The caller's user id (personal-row labeling).
 * @returns The "where live" rows for the lifecycle panel.
 */
export function mapTeamDeploymentRows(deployments: Deployment[], projectId: string, teams: DeployTeamRefDTO[], ownUserId = ''): TeamDeploymentRowDTO[] {
	return (
		deployments
			// A row without a teamId has no identity to key or address in the
			// where-live panel — drop it (same guard resolveDeployTeams applies).
			.filter((dep) => dep.projectId === projectId && dep.state !== 'removed' && Boolean(dep.teamId))
			.map((dep) => {
				// Normalize the schedule records (cron string, enabled default).
				const schedules = (dep.schedules ?? {}) as Record<string, { cron?: string; paused?: boolean; ttl?: number; lastRunAt?: number }>;
				return {
					teamId: dep.teamId as string,
					teamName: teamNameOf(teams, dep.teamId as string, ownUserId),
					version: dep.version ?? 0,
					// A record without a state stamp is a live pointer — 'enabled'
					// is the only default inside the state vocabulary.
					state: (dep.state ?? 'enabled') as TeamDeploymentRowDTO['state'],
					deployedAt: dep.deployedAt ?? dep.updatedAt ?? 0,
					schedules: Object.fromEntries(Object.entries(schedules).map(([sourceId, sched]) => [sourceId, { cron: sched.cron ?? '', paused: sched.paused === true, ...(sched.ttl ? { ttl: sched.ttl } : {}), ...(sched.lastRunAt ? { lastRunAt: sched.lastRunAt } : {}) }])),
				};
			})
	);
}

/**
 * Builds the deployment tab's header view model from the SDK record.
 *
 * @param deployment - `client.deploy.get()` result.
 * @param projectId - Fallback display name when the artifact carries none.
 * @returns The header info (name, version, state, attribution).
 */
export function mapDeploymentInfo(deployment: Deployment, projectId: string): DeploymentInfoDTO {
	return {
		pipelineName: deployment.pipelineName || projectId,
		version: deployment.version ?? 0,
		// Same default rule as mapTeamDeploymentRows: no stamp = 'enabled'.
		state: (deployment.state ?? 'enabled') as DeploymentInfoDTO['state'],
		deployedBy: deployment.updatedBy?.display || deployment.updatedBy?.userId || '',
		deployedAt: deployment.updatedAt ?? 0,
	};
}

/**
 * Builds one schedule row per SOURCE component of the artifact (scheduled
 * or not), joined with the deployment's schedule map — the team drawer's
 * sources overview.
 *
 * @param pipeline - The immutable registry artifact (component list source).
 * @param deployment - The deployment record carrying the schedule map.
 * @returns Schedule rows, one per source.
 */
export function mapScheduleRows(pipeline: Record<string, unknown>, deployment: Deployment): DeployScheduleRowDTO[] {
	// One row per SOURCE component; non-sources never schedule.
	const components = Array.isArray(pipeline.components) ? (pipeline.components as Array<{ id?: string; name?: string; config?: { mode?: string } }>) : [];
	return components
		.filter((c) => c.config?.mode === 'Source' && c.id)
		.map((c) => {
			const sched = deployment.schedules?.[c.id as string];
			return {
				sourceId: c.id as string,
				sourceName: c.name || (c.id as string),
				cron: (sched?.cron as string) ?? '',
				paused: sched?.paused === true,
				...(sched?.ttl ? { ttl: sched.ttl as number } : {}),
				...(sched?.lastRunAt ? { lastRunAt: sched.lastRunAt } : {}),
			};
		});
}
