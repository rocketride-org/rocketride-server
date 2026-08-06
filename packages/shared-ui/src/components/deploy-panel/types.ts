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
import { formatTime } from '../../modules/server/util/formatters';

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
}

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
	{ title: 'Actor', field: 'actor', rrType: 'string', rrDefault: true, rrDescription: 'Who performed the action (denormalized — survives account deletion).', width: 160 },
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
			return `${verb} v${row.version}${row.comment ? ` “${row.comment}”` : ''}`;
		},
	},
];
