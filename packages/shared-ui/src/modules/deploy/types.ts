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

/** One team's live deployment of the project (the "where live" rows). */
export interface TeamDeploymentRow {
	teamId: string;
	teamName: string;
	version: number;
	state: 'active' | 'paused' | 'errored' | 'removed';
	// Compact schedule summary, e.g. 'webhook_1 */30' or 'manual'.
	schedulesSummary: string;
	/** Unix seconds of the most recent scheduler dispatch, if any. */
	lastRunAt?: number;
}

/** One audit-trail row (registry + team pointer changes, merged). */
export interface DeployHistoryRow {
	/** Stable append-order identity (the React key). */
	seq: number;
	/** Unix seconds. */
	at: number;
	action: 'publish' | 'deploy' | 'rollback' | 'pause' | 'resume' | 'errored' | 'remove';
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
	enabled: boolean;
	/** Unix seconds of the last dispatch, if any. */
	lastRunAt?: number;
	/** Run window in seconds ('fixed window'); absent = until finished. */
	ttl?: number;
}
