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
}

/** One source line under a where-live deployment group (derived). */
export interface TeamDeploymentSource extends TeamDeploymentSchedule {
	sourceId: string;
	/** Display name (resolved from the pipeline; falls back to the id). */
	sourceName: string;
}

/** One team's live deployment of the project (a where-live GROUP: the team
    header line plus one sub-row per source). Derived by ProjectView from
    {@link TeamDeployment} + the pipeline's source nodes — hosts never
    build this shape. */
export interface TeamDeploymentRow extends Omit<TeamDeployment, 'schedules'> {
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
