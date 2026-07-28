// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Host-side SDK-to-view-model mapping for the deploy surfaces.
 *
 * The extension host fetches through `client.deploy.*` and maps the SDK rows
 * into the serialisable DTOs of `providers/views/deployTypes.ts` BEFORE they
 * cross postMessage — the webviews render view models only, exactly like the
 * rocket-ui hosts (DeployLifecycleProvider / DeploymentPage / useDeployments),
 * whose mapping logic this module mirrors line-for-line.
 */

import type { RocketRideClient, Deployment, DeployArtifact, DeployHistoryEntry } from 'rocketride';
import type { DeployTeamRefDTO, DeployVersionCardDTO, TeamDeploymentRowDTO, DeployHistoryRowDTO, DeployScheduleRowDTO, DeploymentInfoDTO, SidebarDeploymentDTO } from '../../providers/views/deployTypes';

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

	// Step 2: admin expansion — org.admin / sys.admin controls every team.
	const isAdmin = (org?.permissions ?? []).includes('org.admin') || (info?.sysPermissions ?? []).includes('sys.admin');

	// Step 3: prefer the identity's team roster when one exists.
	const orgTeams = org?.teams;
	if (Array.isArray(orgTeams) && orgTeams.length > 0) {
		return orgTeams.filter((t) => t.id).map((t) => ({ id: t.id, name: t.name || t.id, canControl: isAdmin || (t.permissions ?? []).includes('task.control') }));
	}

	// Step 4: OSS / rosterless identity — derive refs from the deployment rows
	// so the surfaces still render; the server enforces real permissions.
	const seen = new Map<string, DeployTeamRefDTO>();
	for (const dep of deployments) {
		if (dep.teamId && !seen.has(dep.teamId)) seen.set(dep.teamId, { id: dep.teamId, name: dep.teamId, canControl: true });
	}
	return [...seen.values()];
}

/**
 * Resolves a team id to its display name, falling back to the id.
 *
 * @param teams - The resolved team refs.
 * @param teamId - The team id to resolve.
 * @returns The team's display name, or the id when unknown.
 */
export function teamNameOf(teams: DeployTeamRefDTO[], teamId: string): string {
	return teams.find((t) => t.id === teamId)?.name ?? teamId;
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
 * @returns History rows for the merged audit grid.
 */
export function mapHistoryRows(rows: DeployHistoryEntry[], teams: DeployTeamRefDTO[]): DeployHistoryRowDTO[] {
	return rows.map((row) => ({
		seq: row.seq ?? 0,
		at: row.at ?? 0,
		action: (row.action ?? 'deploy') as DeployHistoryRowDTO['action'],
		teamId: row.teamId ?? '',
		teamName: row.teamId ? teamNameOf(teams, row.teamId) : '',
		version: row.version ?? 0,
		actor: row.actor?.display || row.actor?.userId || '',
	}));
}

// =============================================================================
// DEPLOYMENT MAPPERS
// =============================================================================

/**
 * Maps deployment rows into the file view's "where live" rows for ONE
 * project — removed rows are hidden, schedules fold into the compact
 * summary, and the newest dispatch across all sources becomes lastRunAt.
 *
 * @param deployments - `client.deploy.list()` rows (all projects).
 * @param projectId - The project whose deployments to keep.
 * @param teams - The resolved team refs (name lookup).
 * @returns The "where live" rows for the lifecycle panel.
 */
export function mapTeamDeploymentRows(deployments: Deployment[], projectId: string, teams: DeployTeamRefDTO[], sourceNames?: Map<string, string>): TeamDeploymentRowDTO[] {
	return deployments
		.filter((dep) => dep.projectId === projectId && dep.state !== 'removed')
		.map((dep) => {
			// Fold the per-source schedules into the compact summary string.
			const schedules = Object.entries(dep.schedules ?? {});
			const armed = schedules.filter(([, sched]) => sched.cron && sched.enabled !== false);
			const lastRun = Math.max(0, ...schedules.map(([, sched]) => sched.lastRunAt ?? 0));
			return {
				teamId: dep.teamId as string,
				teamName: teamNameOf(teams, dep.teamId as string),
				version: dep.version ?? 0,
				state: (dep.state ?? 'active') as TeamDeploymentRowDTO['state'],
				schedulesSummary: armed.length > 0 ? armed.map(([sourceId, sched]) => `${sourceNames?.get(sourceId) ?? sourceId} ${sched.cron}`).join(' · ') : 'manual',
				...(lastRun > 0 ? { lastRunAt: lastRun } : {}),
			};
		});
}

/**
 * Maps deployment rows into sidebar DEPLOYMENTS tree rows (all projects,
 * removed rows hidden), mirroring rocket-ui's RocketSidebar mapping.
 *
 * @param deployments - `client.deploy.list()` rows.
 * @param teams - The resolved team refs (name lookup).
 * @returns Sidebar tree rows grouped later by the shared component.
 */
export function mapSidebarDeployments(deployments: Deployment[], teams: DeployTeamRefDTO[]): SidebarDeploymentDTO[] {
	return deployments
		.filter((dep) => dep.teamId && dep.projectId && dep.state !== 'removed')
		.map((dep) => ({
			teamId: dep.teamId as string,
			teamName: teamNameOf(teams, dep.teamId as string),
			projectId: dep.projectId as string,
			pipelineName: dep.pipelineName || (dep.projectId as string),
			version: dep.version ?? 0,
			state: (dep.state ?? 'active') as SidebarDeploymentDTO['state'],
		}));
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
		state: (deployment.state ?? 'active') as DeploymentInfoDTO['state'],
		deployedBy: deployment.updatedBy?.display || deployment.updatedBy?.userId || '',
		deployedAt: deployment.updatedAt ?? 0,
	};
}

/**
 * Builds one schedule row per SOURCE component of the artifact (scheduled
 * or not), joined with the deployment's schedule map — mirrors rocket-ui's
 * DeploymentPage schedules memo.
 *
 * @param pipeline - The immutable registry artifact (component list source).
 * @param deployment - The deployment record carrying the schedule map.
 * @returns Schedule rows for the STATUS schedules panel.
 */
export function mapScheduleRows(pipeline: Record<string, unknown>, deployment: Deployment): DeployScheduleRowDTO[] {
	// One row per SOURCE component; non-sources never schedule.
	const components = Array.isArray(pipeline.components) ? (pipeline.components as Array<{ id?: string; config?: { mode?: string } }>) : [];
	return components
		.filter((c) => c.config?.mode === 'Source' && c.id)
		.map((c) => {
			const sched = deployment.schedules?.[c.id as string];
			return {
				sourceId: c.id as string,
				sourceName: (c as { name?: string }).name || (c.id as string),
				cron: sched?.cron ?? '',
				enabled: sched?.enabled !== false,
				...(sched?.ttl ? { ttl: sched.ttl } : {}),
				...(sched?.lastRunAt ? { lastRunAt: sched.lastRunAt } : {}),
			};
		});
}
