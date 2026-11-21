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
// Rows name their audience themselves (plan 2.5): the server composes each
// row's `rung` and `handle` for its reader, so nothing here parses a
// `teamId` — it is shown by its handle and passed back unchanged.

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
 * Maps audit-trail rows into history rows named by the server's handle.
 *
 * @param rows - `client.deploy.history()` rows, newest first.
 * @returns History rows for the merged audit grid.
 */
export function mapHistoryRows(rows: DeployHistoryEntry[]): DeployHistoryRowDTO[] {
	return rows.map((row) => ({
		seq: row.seq ?? 0,
		at: row.at ?? 0,
		action: (row.action ?? 'deploy') as DeployHistoryRowDTO['action'],
		teamId: row.teamId ?? '',
		teamName: row.teamId ? row.handle || row.teamId : '',
		version: row.version ?? 0,
		actor: row.actor?.display || row.actor?.userId || '',
	}));
}

// =============================================================================
// DEPLOYMENT MAPPERS
// =============================================================================

/** The rungs the where-live panel draws; the org rung arrives with C.35. */
const DRAWN_RUNGS: ReadonlySet<string> = new Set<string>(['me', 'personal', 'team', 'public']);

/**
 * Maps deployment rows into the file view's "where live" facts for ONE
 * project — removed rows are hidden. RAW facts only: source names are
 * resolved by the shared ProjectView against the pipeline it holds.
 *
 * @param deployments - `client.deploy.list()` rows (all projects).
 * @param registryId - The pipe's registry name (`registryIdOf`), the id every row carries.
 * @param teams - The caller's team refs, whose ids are the teams' audiences:
 *                a team row is named by its ref, any other row by its handle.
 *                Every row keeps the server's handle for the table to show.
 * @returns The "where live" rows for the lifecycle panel.
 */
export function mapTeamDeploymentRows(deployments: Deployment[], registryId: string, teams: DeployTeamRefDTO[]): TeamDeploymentRowDTO[] {
	return (
		deployments
			// A row without a teamId has no identity to key or address in the
			// where-live panel, and one on a rung it does not draw has no place
			// in it — drop both.
			.filter((dep) => dep.projectId === registryId && dep.state !== 'removed' && Boolean(dep.teamId) && DRAWN_RUNGS.has(dep.rung ?? ''))
			.map((dep) => {
				// Normalize the schedule records (cron string, enabled default).
				const schedules = (dep.schedules ?? {}) as Record<string, { cron?: string; paused?: boolean; ttl?: number; lastRunAt?: number }>;
				return {
					teamId: dep.teamId as string,
					teamName: teams.find((team) => team.id === dep.teamId)?.name ?? (dep.handle || (dep.teamId as string)),
					handle: dep.handle ?? '',
					rung: dep.rung as TeamDeploymentRowDTO['rung'],
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
