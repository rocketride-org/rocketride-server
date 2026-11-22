// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deploy module types — shared between the file view's DEPLOY page
 * (DeployPanel) and the file-less deployment tab (DeploymentView).
 *
 * All shapes are host-agnostic view models: the host maps SDK results
 * (client.deploy.*) into these, resolving team display names and actor
 * strings, so the components carry no client dependency and both hosts
 * (rocket-ui, VS Code) can reuse them.
 */

import type { CellComponent } from 'tabulator-tables';

import type { GridColumnDefinition } from 'shell';
import { formatTime } from 'shell';

// =============================================================================
// DATA TYPES
// =============================================================================

/** A team the caller can see (and possibly deploy to). */
export interface DeployTeamRef {
	/** Team id (the environment identity). */
	id: string;
	/** Team display name. */
	name: string;
	/** Caller holds task.control on this team (may deploy/pause/schedule). */
	canControl: boolean;
}

/** One immutable registry version, as rendered on the version strip. */
export interface DeployVersionCard {
	version: number;
	/** Full sha256 (rendered truncated). */
	sha256: string;
	/** Unix seconds. */
	publishedAt: number;
	/** Publisher display name (denormalized — survives account deletion). */
	publishedBy: string;
	/** Optional "what changed" note. */
	comment?: string;
	/** Whether `deploy delete` would take this version right now (no rung
	 *  pins it, not in review, not building) — computed by the server on
	 *  every read. The card shows its delete mark only when true. */
	deletable?: boolean;
	/** The version's review state on the store ladder (plan 10.1): 'private'
	 *  (a draft), 'submit' (in review), 'ready' (approved for the store),
	 *  'rejected', or 'failed'. Absent when the rail could not be read: the
	 *  card then shows no badge and offers no review verb. */
	state?: 'private' | 'submit' | 'ready' | 'rejected' | 'failed';
}

/** Which rung a deployment row is, from the caller's side: 'me' (their own
    personal space, addressed '@me'), 'personal' (another user's personal
    space, which only an org admin sees), 'team', 'org' (the organisation,
    published by org admins), or 'public' (the store). */
export type DeploymentRung = 'me' | 'personal' | 'team' | 'org' | 'public';

/** Per-source schedule facts on a live deployment (keyed by sourceId). */
export interface TeamDeploymentSchedule {
	/** 5-field cron, or '' when the source has no schedule (manual). */
	cron: string;
	/** Paused schedules stay configured (cron/ttl kept) but never fire. */
	paused: boolean;
	/** Run window seconds ('fixed window'); absent = until finished. */
	ttl?: number;
	/** Unix seconds of the last scheduler dispatch, if any. */
	lastRunAt?: number;
}

/** One team's live deployment of the project as the HOST feeds it: raw
    SDK facts only (team, pointer, state, schedule records). Source names
    are NOT here — ProjectView resolves them against the pipeline it
    already holds, so the derivation exists exactly once. */
export interface TeamDeployment {
	teamId: string;
	teamName: string;
	/** The audience's handle as the server composed it for the caller
	    ('@me', '@<team>', '@public', '=team/<tid>', 'Personal'); shown, never parsed. */
	handle: string;
	/** The rung the row's slot is (stamped by the host, which knows the caller). */
	rung: DeploymentRung;
	version: number;
	/** 'disabled' is the whole-deployment kill switch — nothing runs. */
	state: 'enabled' | 'disabled' | 'errored' | 'removed';
	/** Unix seconds of the pointer move (the header's deployed-at). */
	deployedAt: number;
	/** Schedule records keyed by sourceId. */
	schedules: Record<string, TeamDeploymentSchedule>;
	/** Sources with a LIVE run right now (host-fed from task events). */
	runningSources?: Record<string, boolean>;
}

/** One source line under a where-live deployment group (derived). */
export interface TeamDeploymentSource extends TeamDeploymentSchedule {
	sourceId: string;
	/** Display name (resolved from the pipeline; falls back to the id). */
	sourceName: string;
	/** True while this source has a live run (drives the running badge). */
	running?: boolean;
}

/** One team's live deployment of the project (a where-live GROUP: the team
    header line plus one sub-row per source). Derived by ProjectView from
    {@link TeamDeployment} + the pipeline's source nodes — hosts never
    build this shape. `runningSources` is omitted because the derivation
    folds the running fact into each source row's `running` flag — the row
    carries exactly one representation of it. */
export interface TeamDeploymentRow extends Omit<TeamDeployment, 'schedules' | 'runningSources'> {
	/** Per-source lines (pipeline sources ∪ schedule records). */
	sources: TeamDeploymentSource[];
}

/** One audit-trail row (registry + team pointer changes, merged). */
export interface DeployHistoryRow {
	/** Stable append-order identity (the React key). */
	seq: number;
	/** Unix seconds. */
	at: number;
	action: 'publish' | 'deploy' | 'rollback' | 'enable' | 'disable' | 'pause' | 'resume' | 'errored' | 'remove';
	/** '' on org-wide publish rows. */
	teamId: string;
	/** Team display name ('' on publish rows). */
	teamName: string;
	version: number;
	/** Actor display name. */
	actor: string;
	/** Publish comment (publish rows only). */
	comment?: string;
}

/** Per-source schedule row on a team deployment. */
export interface DeployScheduleRow {
	sourceId: string;
	/** Source display name from the artifact (falls back to the id). */
	sourceName?: string;
	/** 5-field cron, or '' when the source has no schedule (manual). */
	cron: string;
	/** Paused schedules stay configured (cron/ttl kept) but never fire. */
	paused: boolean;
	/** Unix seconds of the last dispatch, if any. */
	lastRunAt?: number;
	/** Run window in seconds ('fixed window'); absent = until finished. */
	ttl?: number;
}

/** Past-tense verb per audit action — THE one display vocabulary for the
    history grids (DeploymentView and TeamDeploymentRecordPanel render the
    same trail; two hand-copied maps would drift when an action is added).
    'pause'/'resume' appear only on rows written before the enable/disable
    vocabulary. Unknown actions fall back to the raw action string. */
export const DEPLOY_ACTION_VERBS: Record<string, string> = {
	publish: 'published',
	deploy: 'deployed',
	rollback: 'rolled back',
	enable: 'enabled',
	disable: 'disabled',
	errored: 'errored',
	remove: 'removed',
	pause: 'paused',
	resume: 'resumed',
};

/** State → chip color — THE one state palette for the deploy surfaces
    (DeploymentView and TeamDeploymentRecordPanel render the same header
    chip; two hand-copied maps would drift when a state is recolored). */
export const DEPLOY_STATE_COLOR: Record<TeamDeployment['state'], string> = {
	enabled: 'var(--rr-color-success)',
	disabled: 'var(--rr-text-secondary)',
	errored: 'var(--rr-color-error)',
	removed: 'var(--rr-text-disabled)',
};

/**
 * The audit-trail grid's column set — THE one definition for the history
 * grids (DeploymentView and TeamDeploymentRecordPanel render the identical
 * trail). A factory rather than a shared const because Tabulator treats
 * column definition objects as its own mutable state.
 *
 * @returns Fresh column definitions for a CardDataGrid history table.
 */
export const createDeployHistoryColumns = (): GridColumnDefinition[] => [
	{
		title: 'When',
		field: 'at',
		rrType: 'date',
		rrDefault: true,
		rrDefaultSort: 'desc',
		rrDescription: 'When the action happened (local time); newest first.',
		formatter: (cell: CellComponent) => formatTime(cell.getValue() as number),
		width: 170,
	},
	{ title: 'Actor', field: 'actor', rrType: 'string', rrDefault: true, rrDescription: 'Who performed the action (denormalized, so it survives account deletion).', width: 160 },
	{
		title: 'Action',
		field: 'seq',
		rrNoPopup: true,
		rrDefault: true,
		rrDescription: 'What happened to this team deployment: deploys, rollbacks, enables/disables, removals; publishes ride along org-wide.',
		widthGrow: 3,
		formatter: (cell: CellComponent) => {
			const row = cell.getRow().getData() as DeployHistoryRow;
			// Past-tense verbs; 'pause'/'resume' appear only on rows
			// written before the enable/disable vocabulary.
			const verb = DEPLOY_ACTION_VERBS[row.action] ?? row.action;
			// A DOM node keeps the user-authored comment as TEXT — Tabulator
			// inserts a returned STRING as markup.
			const span = document.createElement('span');
			span.textContent = `${verb} v${row.version}${row.comment ? ` “${row.comment}”` : ''}`;
			return span;
		},
	},
];
