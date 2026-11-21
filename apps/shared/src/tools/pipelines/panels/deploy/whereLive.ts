// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The pipeline DEPLOY page's rung rules (mockups 2.13 and 2.14), pure so
 * they are tested once:
 *
 * - "Where this project is live" has ONE ROW PER RUNG holding a
 *   publication, in rung order: Me (@me), other users' personal spaces (an
 *   org admin sees them), the teams in the caller's roster order, then the
 *   store (@public). A removed publication has no row.
 * - A row names its rung by label and handle: 'Me @me', 'Staging
 *   @team/Staging', 'Store @public'. A version card's audience chips use
 *   the same labels.
 * - Every rung's sources take a schedule (decided 2026-11-20): any
 *   publication of a pipe can run on a timer, billed to the team stamped
 *   when it was published.
 * - A row's serving state is phrased by the App Builder's `pinStatusOf`:
 *   a serving row says nothing, a disabled or errored one says so.
 * - The Publish dialog offers each audience the caller controls with what
 *   it serves now, then the store; the audience already on the version is
 *   not choosable, and the store opens only on an approved version (a
 *   pipe's store needs 'ready' on every server; without a reviewer every
 *   deployed version is born 'ready'). Rows carry their audience as the
 *   server composed it (`=user/<uid>`, `=team/<tid>`, `@public`) and the
 *   roster's team ids are the same strings, while the dialog addresses the
 *   caller's own space '@me': the caller's own row and the store's match
 *   by rung, a team's by its audience.
 */

import { STORE_TARGET_ID, storeTargetOf } from 'shared/components/deploy/reviewRules';
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

/** The store as an audience the Publish dialog's choice stages (its row label is 'Public: the store'). */
export const STORE_AUDIENCE: DeployTeamRef = { id: STORE_TARGET_ID, name: 'the store', canControl: true };

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
 * rung order, each with its label and handle.
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
		.map((row) => ({ row, label: labelOf(row), handle: handleOf(row) }))
		.sort((a, b) => RUNG_ORDER[a.row.rung] - RUNG_ORDER[b.row.rung] || rosterIndex(a.row) - rosterIndex(b.row) || a.label.localeCompare(b.label));
}

/**
 * The publication an audience points at now.
 *
 * @param rows - This project's publication rows.
 * @param targetId - The audience as the dialog names it: '@me', '@public', or a team's audience.
 * @returns The live row, or undefined when the audience has none.
 */
export function rowOfTarget(rows: readonly TeamDeploymentRow[], targetId: string): TeamDeploymentRow | undefined {
	const rung: DeploymentRung = targetId === '@me' ? 'me' : targetId === STORE_TARGET_ID ? 'public' : 'team';
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
 * One audience's dialog row: what it points at now; not choosable when it
 * already points at the version.
 *
 * @param id - The audience as the dialog names it.
 * @param label - The row label.
 * @param current - The audience's live row, if any.
 * @param version - The version being published.
 * @returns The row.
 */
function targetOf(id: string, label: string, current: TeamDeploymentRow | undefined, version: number): IPublishTarget {
	if (!current) return { id, label, note: 'not published yet' };
	if (current.version === version) return { id, label, note: `already on v${version}`, disabled: true, disabledTitle: `${label} already points at v${version}` };
	return { id, label, note: current.version > version ? `rollback from v${current.version}` : `upgrade from v${current.version}` };
}

/**
 * The Publish dialog's audience rows for one version: every audience the
 * caller controls ('@me' first, as the roster lists it), then the store,
 * each with what it serves now. The audience already on the version stays
 * visible and cannot be chosen; the store also stays closed, with the
 * reason, until the version is approved ('ready').
 *
 * @param teams - The caller's roster with control rights.
 * @param rows - This project's publication rows.
 * @param version - The version being published.
 * @param state - The version's review state (undefined when unknown: the store stays closed).
 * @returns The rows: the roster's, then the store's.
 */
export function publishTargetsOf(teams: readonly DeployTeamRef[], rows: readonly TeamDeploymentRow[], version: number, state: string | undefined): IPublishTarget[] {
	const audiences = teams.filter((team) => team.canControl).map((team) => targetOf(team.id, team.name, rowOfTarget(rows, team.id), version));
	const store = targetOf(STORE_TARGET_ID, 'Public: the store', rowOfTarget(rows, STORE_TARGET_ID), version);
	// The review gate comes first; an open store is still not choosable when it already serves the version
	const gate = storeTargetOf({ label: store.label, state, needsApproval: true, note: store.note });
	return [...audiences, gate.disabled ? gate : store];
}

/**
 * The audience a dialog choice stages: the store, or one of the caller's teams.
 *
 * @param teams - The caller's roster.
 * @param id - The chosen row's id.
 * @returns The audience, or undefined for an id the roster does not hold.
 */
export function audienceOfTarget(teams: readonly DeployTeamRef[], id: string): DeployTeamRef | undefined {
	return id === STORE_TARGET_ID ? STORE_AUDIENCE : teams.find((team) => team.id === id);
}
