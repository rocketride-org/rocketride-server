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
 * The view-model DTOs mirror `packages/shared-ui/src/modules/deploy/types.ts`
 * (the contract of record) field-for-field, so the webview can hand them to
 * the shared DeployPanel / DeploymentView components unchanged —
 * structural typing keeps the two in lockstep, and the extension host does
 * ALL SDK-to-view-model mapping before anything crosses postMessage.
 */

// =============================================================================
// VIEW-MODEL DTOS (mirror shared-ui deploy/types.ts)
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

/** One team's live deployment of the project (the "where live" rows). */
export interface TeamDeploymentRowDTO {
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
export interface DeployHistoryRowDTO {
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
export interface DeployScheduleRowDTO {
	sourceId: string;
	/** 5-field cron, or '' when the source has no schedule (manual). */
	cron: string;
	enabled: boolean;
	/** Unix seconds of the last dispatch, if any. */
	lastRunAt?: number;
}

/** The deployment header state rendered on the deployment tab. */
export interface DeploymentInfoDTO {
	/** Pipeline display name (from the registry artifact). */
	pipelineName: string;
	/** The registry version this team points at. */
	version: number;
	state: 'active' | 'paused' | 'errored' | 'removed';
	/** Deployed-by attribution (display name). */
	deployedBy: string;
	/** Unix seconds of the pointer move. */
	deployedAt: number;
}

/** One deployment row in the sidebar DEPLOYMENTS tree. */
export interface SidebarDeploymentDTO {
	/** Owning team id (the environment). */
	teamId: string;
	/** Team display name (host-resolved; falls back to the id). */
	teamName: string;
	/** Deployed project id. */
	projectId: string;
	/** Pipeline display name from the registry artifact. */
	pipelineName: string;
	/** The registry version this team points at. */
	version: number;
	/** Deployment state (removed rows never reach the sidebar). */
	state: 'active' | 'paused' | 'errored';
}

/** Cron preview result from the server's single evaluator. */
export interface SchedulePreviewResultDTO {
	valid?: boolean;
	error?: string;
	next?: number[];
}

// =============================================================================
// DEPLOY LIFECYCLE PROTOCOL (file view's DEPLOY page)
// =============================================================================

/** Deploy-lifecycle messages the extension host sends to the Project webview. */
export type DeployLifecycleHostToWebview =
	| {
			/** The full lifecycle snapshot (pushed on fetch and after mutations). */
			type: 'deploy:data';
			/** Registry versions, newest first. */
			versions: DeployVersionCardDTO[];
			/** This project's team deployments (the "where live" rows). */
			deployments: TeamDeploymentRowDTO[];
			/** Merged audit history, newest first. */
			history: DeployHistoryRowDTO[];
			/** Teams visible to the caller, with resolved names + control rights. */
			teams: DeployTeamRefDTO[];
	  }
	| {
			/** Completion ack for a deploy:publish / deploy:deploy request. */
			type: 'deploy:actionResult';
			/** Correlates with the request that started the action. */
			requestId: number;
			/** Present when the action failed (surfaces in the panel). */
			error?: string;
	  };

/** Deploy-lifecycle messages the Project webview sends to the extension host. */
export type DeployLifecycleWebviewToHost =
	| {
			/** Request the lifecycle snapshot for this project. */
			type: 'deploy:fetch';
			/** The file's project id (registry key). */
			projectId: string;
	  }
	| {
			/** Publish the SAVED document as the next registry version. */
			type: 'deploy:publish';
			/** Correlation id for the deploy:actionResult reply. */
			requestId: number;
			/** "What changed" note kept in the registry. */
			comment: string;
			/** Team id for one-step publish+deploy, when chosen. */
			deployTo?: string;
	  }
	| {
			/** Point a team at a version (promotion and rollback alike). */
			type: 'deploy:deploy';
			/** Correlation id for the deploy:actionResult reply. */
			requestId: number;
			projectId: string;
			version: number;
			teamId: string;
	  }
	| {
			/** Open the file-less deployment tab for one team. */
			type: 'deploy:openDeployment';
			teamId: string;
			projectId: string;
			/** Tab title, e.g. 'Production / invoice-flow'. */
			title: string;
	  };

// =============================================================================
// DEPLOYMENT TAB PROTOCOL (file-less per-team deployment panel)
// =============================================================================

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
	/** Per-source schedules, for the STATUS schedules panel. */
	schedules: DeployScheduleRowDTO[];
	/** This team's audit history, newest first. */
	history: DeployHistoryRowDTO[];
	/** Registry versions (the Deploy version… / Rollback pickers). */
	versions: DeployVersionCardDTO[];
	/** Next scheduled occurrence (host-previewed), if any schedule is armed. */
	nextRun?: { at: number; sourceId: string; cron: string };
	/** sourceId -> true while a run of that source is live on the server. */
	runningSources: Record<string, boolean>;
	/** Caller holds task.control on this team (actions render only then). */
	canControl: boolean;
	/** Whether the dev connection is currently up. */
	isConnected: boolean;
}

/** All messages the extension host can send to the Deployment webview. */
export type DeploymentHostToWebview =
	| ({ type: 'deployment:load' } & DeploymentLoadPayload)
	| {
			/** The deployment could not be loaded (rendered as the page state). */
			type: 'deployment:error';
			error: string;
	  }
	| {
			/** Completion ack for any deployment:* mutation request. */
			type: 'deployment:actionResult';
			requestId: number;
			/** Present when the action failed (surfaces in the view). */
			error?: string;
	  }
	| {
			/** Reply to deployment:preview (THE single cron evaluator). */
			type: 'deployment:previewResult';
			requestId: number;
			result: SchedulePreviewResultDTO;
			/** Present when the preview call itself failed. */
			error?: string;
	  }
	| {
			/** Reply to deployment:validate for the readonly canvas. */
			type: 'deployment:validateResult';
			requestId: number;
			result: { errors: unknown[]; warnings: unknown[] };
	  }
	| { type: 'shell:connectionChange'; isConnected: boolean };

/** All messages the Deployment webview can send to the extension host. */
export type DeploymentWebviewToHost =
	| { type: 'view:ready' }
	| {
			/** Pause (true) / resume (false) this team deployment. */
			type: 'deployment:setPaused';
			requestId: number;
			paused: boolean;
	  }
	| {
			/** Point this team at a version (Deploy version… / Rollback alike). */
			type: 'deployment:deployVersion';
			requestId: number;
			version: number;
	  }
	| {
			/** Soft-remove this team deployment (host closes the panel). */
			type: 'deployment:remove';
			requestId: number;
	  }
	| {
			/** Start one source NOW (the manual smoke-test dispatch). */
			type: 'deployment:runSource';
			requestId: number;
			sourceId: string;
	  }
	| {
			/** Stop one source's live run. */
			type: 'deployment:stopSource';
			requestId: number;
			sourceId: string;
	  }
	| {
			/** Set (cron string) or clear (null) one source's schedule. */
			type: 'deployment:setSchedule';
			requestId: number;
			sourceId: string;
			cron: string | null;
			enabled: boolean;
			/** Run window in seconds ('fixed window'); null = until finished. */
			ttl?: number | null;
	  }
	| {
			/** Cron preview via the server's single evaluator. */
			type: 'deployment:preview';
			requestId: number;
			cron: string;
			count: number;
	  }
	| {
			/** Pipeline validation passthrough for the readonly canvas. */
			type: 'deployment:validate';
			requestId: number;
			pipeline: unknown;
	  };
