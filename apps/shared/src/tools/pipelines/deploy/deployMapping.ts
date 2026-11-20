// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SDK-to-view-model mapping for the pipeline page's deploy surfaces.
 *
 * REALM-SIDE since the bus migration: the page fetches through the brokered
 * `client.deploy.*` ops and maps the SDK rows into the DTOs of
 * `deployTypes.ts` (beside this module) before handing them to the shared deploy
 * components. Team resolution is the ONE shared implementation
 * (shared/components/deploy-panel/teams — rocket-ui consumes the same one).
 */

import type { Deployment, DeployArtifact, DeployHistoryEntry } from 'rocketride';
import type { DeployTeamRefDTO, DeployVersionCardDTO, TeamDeploymentRowDTO, DeployHistoryRowDTO, DeployScheduleRowDTO, DeploymentInfoDTO } from './deployTypes';
// Team resolution (roster, display names, '@me' addressing) is the SDK's —
// one implementation shared with the `rocketride` CLI and every host.
import { teamNameOf } from 'rocketride';

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
		// The server's own delete check; an older row source carries none,
		// and a card without the flag draws no mark (never a guess).
		...(v.deletable !== undefined ? { deletable: v.deletable } : {}),
	}));
}

/**
 * Joins each version card with its review state from the version rail
 * (`client.listDeployments`: the read the App Builder's DEPLOY view and the
 * pipeline's PACKAGE › Review make; `rrext_deploy_app` reads pipe artifacts
 * since C.17). A card the rail does not name keeps no state, so it shows no
 * badge and offers no review verb: never a guessed 'draft'.
 *
 * @param cards - The version cards, newest first.
 * @param rail - The rail rows (`registryVersion` + `state`).
 * @returns The cards, each with its state when the rail names one.
 */
export function withReviewStates(cards: DeployVersionCardDTO[], rail: ReadonlyArray<{ registryVersion: number; state?: string }>): DeployVersionCardDTO[] {
	const states = new Map(rail.map((row) => [row.registryVersion, row.state ?? '']));
	return cards.map((card) => {
		const state = states.get(card.version);
		// A state the server adds later passes through: the badge shows its
		// raw name, muted (versionBadgeOf), as on the App Builder's cards.
		return state ? { ...card, state: state as DeployVersionCardDTO['state'] } : card;
	});
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
 * Which rung a publication row's slot is, from the caller's side. Slots
 * follow the one audience grammar (plan 10.1): `user~{uid}` for a personal
 * space, a team id, or `~public` for the store.
 *
 * @param slot - The row's `teamId` (its audience slot).
 * @param ownUserId - The caller's user id ('' when unknown).
 * @returns 'me' (the caller's own space), 'personal' (another user's),
 *          'public', or 'team'.
 */
export function rungOfSlot(slot: string, ownUserId = ''): TeamDeploymentRowDTO['rung'] {
	if (slot === '~public') return 'public';
	if (slot.startsWith('user~')) return ownUserId && slot === `user~${ownUserId}` ? 'me' : 'personal';
	return 'team';
}

/**
 * Maps deployment rows into the file view's "where live" facts for ONE
 * project — removed rows are hidden. RAW facts only: source names are
 * resolved by the shared ProjectView against the pipeline it holds.
 *
 * @param deployments - `client.deploy.list()` rows (all projects).
 * @param registryId - The pipe's registry name (`registryIdOf`), the id every row carries.
 * @param teams - The resolved team refs (name lookup).
 * @param ownUserId - The caller's user id (personal-row labeling).
 * @returns The "where live" rows for the lifecycle panel.
 */
export function mapTeamDeploymentRows(deployments: Deployment[], registryId: string, teams: DeployTeamRefDTO[], ownUserId = ''): TeamDeploymentRowDTO[] {
	return (
		deployments
			// A row without a teamId has no identity to key or address in the
			// where-live panel — drop it (same guard resolveDeployTeams applies).
			.filter((dep) => dep.projectId === registryId && dep.state !== 'removed' && Boolean(dep.teamId))
			.map((dep) => {
				// Normalize the schedule records (cron string, enabled default).
				const schedules = (dep.schedules ?? {}) as Record<string, { cron?: string; paused?: boolean; ttl?: number; lastRunAt?: number }>;
				return {
					teamId: dep.teamId as string,
					teamName: teamNameOf(teams, dep.teamId as string, ownUserId),
					rung: rungOfSlot(dep.teamId as string, ownUserId),
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
