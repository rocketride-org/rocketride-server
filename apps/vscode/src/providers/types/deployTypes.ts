// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deploy surfaces webview message protocol types.
 *
 * Separated from `types.ts` so the extension host can import these without
 * pulling in `shared/modules/*` (which is only resolvable under the webview
 * tsconfig).
 *
 * The view-model DTOs mirror `packages/shared/src/components/deploy-panel/types.ts`
 * (the contract of record) field-for-field, so the webview can hand them to
 * the shared DeployPanel / DeploymentView components unchanged —
 * structural typing keeps the two in lockstep, and the extension host does
 * ALL SDK-to-view-model mapping before anything crosses postMessage.
 */

// =============================================================================
// VIEW-MODEL DTOS (mirror shared deploy/types.ts)
// =============================================================================

/** A team the caller can see (and possibly deploy to). */
export interface DeployTeamRefDTO {
	/** Team id (the environment identity). */
	id: string;
	/** Team display name. */
	name: string;
	/** Caller holds task.control on this team (may deploy/pause/schedule). */
	canControl: boolean;
}

/** One immutable registry version, as rendered on the version strip. */
export interface DeployVersionCardDTO {
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

/** Per-source schedule facts (keyed by sourceId on the row). */
export interface TeamDeploymentScheduleDTO {
	/** 5-field cron, or '' when the source has no schedule (manual). */
	cron: string;
	/** Paused schedules stay configured (cron/ttl kept) but never fire. */
	paused: boolean;
	/** Run window seconds ('fixed window'); absent = until finished. */
	ttl?: number;
	/** Unix seconds of the last scheduler dispatch, if any. */
	lastRunAt?: number;
}

/** One team's live deployment of the project — RAW facts only (mirrors
    shared TeamDeployment). Source names are resolved by the shared
    ProjectView against the pipeline it holds, never host-side. */
export interface TeamDeploymentRowDTO {
	teamId: string;
	teamName: string;
	version: number;
	state: 'enabled' | 'disabled' | 'errored' | 'removed';
	/** Unix seconds of the pointer move (the header's deployed-at). */
	deployedAt: number;
	/** Schedule records keyed by sourceId. */
	schedules: Record<string, TeamDeploymentScheduleDTO>;
}

/** One audit-trail row (registry + team pointer changes, merged). */
export interface DeployHistoryRowDTO {
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

/** Per-source schedule row on a team deployment (paused flag + window). */
export interface DeployScheduleRowDTO {
	sourceId: string;
	/** Display name from the artifact (falls back to the id). */
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

/** The deployment header state rendered on the deployment tab. */
export interface DeploymentInfoDTO {
	/** Pipeline display name (from the registry artifact). */
	pipelineName: string;
	/** The registry version this team points at. */
	version: number;
	state: 'enabled' | 'disabled' | 'errored' | 'removed';
	/** Deployed-by attribution (display name). */
	deployedBy: string;
	/** Unix seconds of the pointer move. */
	deployedAt: number;
}

/** Cron preview result from the server's single evaluator. */
export interface SchedulePreviewResultDTO {
	valid?: boolean;
	error?: string;
	next?: number[];
}

// =============================================================================
// DEPLOYMENT RECORD DRAWER PROTOCOL (rides the Project webview channel)
// =============================================================================
// The drawer lives INSIDE the Project webview, so every message carries the
// TEAM identity (the project identity is the panel's own); replies stamp it
// back so a switched drawer ignores stale pushes.

/** The full state payload of one team deployment (host-mapped view models). */
export interface DeploymentLoadPayload {
	/** Team display name (tab context, e.g. 'Production'). */
	teamName: string;
	/** The deployment record (header + state). */
	deployment: DeploymentInfoDTO;
	/** The immutable registry artifact this team runs (readonly DESIGN). */
	pipeline: Record<string, unknown>;
	/** Service catalog for the readonly canvas render. */
	servicesJson: Record<string, unknown>;
	/** The FOCUSED source id; absent = the TEAM record. */
	sourceId?: string;
	/** Focused source display name (artifact-resolved; id fallback). */
	sourceName?: string;
	/** The focused source's schedule paused flag; absent = no schedule. */
	sourcePaused?: boolean;
	/** The focused source's execution settings (server truth). */
	sourceConfig?: { traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null; debugOut: boolean };
	/** One row per source (artifact sources with their schedule records) —
	    the team drawer's sources overview. */
	schedules: DeployScheduleRowDTO[];
	/** Per-source next occurrence (host-previewed), keyed by sourceId —
	    the team drawer's status-grid Next-run column. */
	nextRuns?: Record<string, number>;
	/** Registry versions (the team drawer's Deploy version… picker). */
	versions: DeployVersionCardDTO[];
	/** This team's audit history, newest first. */
	history: DeployHistoryRowDTO[];
	/** Next scheduled occurrence (host-previewed), if any schedule is armed. */
	nextRun?: { at: number; sourceId: string; cron: string };
	/** sourceId -> true while a run of that source is live on the server. */
	runningSources: Record<string, boolean>;
	/** Caller holds task.control on this team (actions render only then). */
	canControl: boolean;
	/** Whether the dev connection is currently up. */
	isConnected: boolean;
}
