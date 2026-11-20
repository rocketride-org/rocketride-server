// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The pipeline DEPLOY page's rung rules (mockups 2.13 and 2.15), pure so
 * they are tested once:
 *
 * - "Where this project is live" has ONE ROW PER RUNG holding a
 *   publication, in rung order: Me (@me), other users' personal spaces (an
 *   org admin sees them), the teams in the caller's roster order, then the
 *   store (@public). A removed publication has no row.
 * - A row names its rung by label and handle: 'Me @me', 'Staging
 *   @team/Staging', 'Store @public'.
 * - Only a team rung's sources take a schedule; @me and @public sources
 *   are on demand.
 * - A row's serving state is phrased by the App Builder's `pinStatusOf`:
 *   a serving row says nothing, a disabled or errored one says so.
 * - The Publish dialog offers each audience the caller controls with what
 *   it serves now; the audience already on the version is not choosable.
 *   Personal rows carry the raw slot `user~{uid}` while the caller's own
 *   audience is addressed '@me', so audiences match rows by rung.
 */

import type { IPublishTarget } from 'shared/components/deploy';
import type { DeployTeamRef, DeploymentRung, TeamDeploymentRow } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** One where-live row as the table draws it. */
export interface IWhereLiveRung {
	/** The publication row. */
	row: TeamDeploymentRow;
	/** The rung's label: 'Me', the team's name, 'Store' (another user's space keeps its row name). */
	label: string;
	/** The rung's handle: '@me', '@team/<name>', '@public'; '' for another user's space. */
	handle: string;
	/** Whether the row's sources take a schedule (team rungs only). */
	scheduleEditable: boolean;
}

/** A row's serving facts in the shape `pinStatusOf` reads. */
export interface IRowServing {
	/** Whether the publication serves. */
	serving: boolean;
	/** Why not ('' while serving): the row's own state, 'disabled' or 'errored'. */
	reason: string;
	/** The pin's review-gate field, read only for an older server's pins (never a pipeline row's). */
	state: 'enabled';
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Display order of the rungs: the caller's own space first, the store last. */
const RUNG_ORDER: Record<DeploymentRung, number> = { me: 0, personal: 1, team: 2, public: 3 };

// =============================================================================
// RULES
// =============================================================================

/** The rung's label ('Me', a team name, 'Store'). */
function labelOf(row: TeamDeploymentRow): string {
	if (row.rung === 'me') return 'Me';
	if (row.rung === 'public') return 'Store';
	return row.teamName;
}

/** The rung's handle ('@me', '@team/<name>', '@public'; none for another user's space). */
function handleOf(row: TeamDeploymentRow): string {
	if (row.rung === 'me') return '@me';
	if (row.rung === 'public') return '@public';
	if (row.rung === 'team') return `@team/${row.teamName}`;
	return '';
}

/**
 * The where-live table's rows: one per rung that holds a publication, in
 * rung order, each with its label, handle and schedule rule.
 *
 * @param rows - This project's publication rows (any order).
 * @param teams - The caller's roster (its order is the team rows' order).
 * @returns The rows to draw.
 */
export function whereLiveRungsOf(rows: readonly TeamDeploymentRow[], teams: readonly DeployTeamRef[]): IWhereLiveRung[] {
	const roster = new Map(teams.map((team, index) => [team.id, index]));
	/** A team row's roster position; teams outside the roster go after it. */
	const rosterIndex = (row: TeamDeploymentRow): number => roster.get(row.teamId) ?? teams.length;
	return rows
		.filter((row) => row.state !== 'removed')
		.map((row) => ({ row, label: labelOf(row), handle: handleOf(row), scheduleEditable: row.rung === 'team' }))
		.sort((a, b) => RUNG_ORDER[a.row.rung] - RUNG_ORDER[b.row.rung] || rosterIndex(a.row) - rosterIndex(b.row) || a.label.localeCompare(b.label));
}

/**
 * The publication an audience points at now.
 *
 * @param rows - This project's publication rows.
 * @param targetId - The audience as the dialog names it: '@me', '@public', or a team id.
 * @returns The live row, or undefined when the audience has none.
 */
export function rowOfTarget(rows: readonly TeamDeploymentRow[], targetId: string): TeamDeploymentRow | undefined {
	const rung: DeploymentRung = targetId === '@me' ? 'me' : targetId === '@public' ? 'public' : 'team';
	return rows.find((row) => row.state !== 'removed' && row.rung === rung && (rung !== 'team' || row.teamId === targetId));
}

/**
 * A row's serving facts for `pinStatusOf`: a publication serves while it is
 * enabled; otherwise its state is the reason.
 *
 * @param row - The publication row.
 * @returns The facts.
 */
export function servingOf(row: Pick<TeamDeploymentRow, 'state'>): IRowServing {
	const serving = row.state === 'enabled';
	return { serving, reason: serving ? '' : row.state, state: 'enabled' };
}

/**
 * The Publish dialog's audience rows for one version: every audience the
 * caller controls ('@me' first, as the roster lists it), with what it
 * serves now. The audience already on the version stays visible and cannot
 * be chosen.
 *
 * @param teams - The caller's roster with control rights.
 * @param rows - This project's publication rows.
 * @param version - The version being published.
 * @returns The rows, in roster order.
 */
export function publishTargetsOf(teams: readonly DeployTeamRef[], rows: readonly TeamDeploymentRow[], version: number): IPublishTarget[] {
	return teams
		.filter((team) => team.canControl)
		.map((team) => {
			const current = rowOfTarget(rows, team.id);
			if (!current) return { id: team.id, label: team.name, note: 'not published yet' };
			if (current.version === version) return { id: team.id, label: team.name, note: `already on v${version}`, disabled: true, disabledTitle: `${team.name} already points at v${version}` };
			return { id: team.id, label: team.name, note: current.version > version ? `rollback from v${current.version}` : `upgrade from v${current.version}` };
		});
}
