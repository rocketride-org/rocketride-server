/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Deploy type definitions for the RocketRide TypeScript SDK.
 *
 * The teams-as-environments model: PUBLISH creates an immutable,
 * sha256-locked artifact version in the ORG registry; DEPLOY points a TEAM
 * at a version (promotion and rollback are the same pointer move); every
 * publish and pointer change is recorded immutably in the audit history.
 */

import type { PipelineConfig } from './pipeline.js';
export type { PipelineConfig };

// =============================================================================
// DEPLOY TYPES
// =============================================================================

/** Denormalized audit identity — survives account deletion. */
export interface DeployActor {
	userId?: string;
	display?: string;
	email?: string;
}

/** One immutable registry version of a project's pipeline. */
export interface DeployArtifact {
	version?: number;
	/** sha256 over the exact stored artifact bytes; verified on every load. */
	sha256?: string;
	bytes?: number;
	pipelineName?: string;
	publishedBy?: DeployActor;
	/** Unix timestamp (seconds). */
	publishedAt?: number;
	/** Optional "what changed" note supplied at publish time. */
	comment?: string;
}

/** Per-source schedule on a team deployment. */
export interface DeploymentSchedule {
	/** 5-field cron expression. */
	cron?: string;
	enabled?: boolean;
	/** Run window in seconds ('fixed window'); null/absent = until finished. */
	ttl?: number | null;
	/** Unix timestamp (seconds) of the last scheduler dispatch, or null. */
	lastRunAt?: number | null;
}

/** One team's deployment of a project, joined with registry info. */
export interface Deployment {
	teamId?: string;
	projectId?: string;
	/** The registry version this team currently points at. */
	version?: number;
	state?: 'active' | 'paused' | 'errored' | 'removed';
	pipelineName?: string;
	/** Per-source schedules, keyed by source id. */
	schedules?: Record<string, DeploymentSchedule>;
	createdAt?: number;
	createdBy?: DeployActor;
	updatedAt?: number;
	updatedBy?: DeployActor;
	/** Registry-joined fields of the pointed-at version. */
	sha256?: string;
	publishedAt?: number;
	publishedBy?: DeployActor;
}

/** One immutable audit-trail row (who did what, where, when). */
export interface DeployHistoryEntry {
	/**
	 * Stable append-order key: newest first, never ties. Use as the row
	 * identity when rendering.
	 */
	seq?: number;
	/** Unix timestamp (seconds). */
	at?: number;
	action?: 'publish' | 'deploy' | 'rollback' | 'pause' | 'resume' | 'errored' | 'remove';
	/** `''` on org-wide rows (publish); the team id on pointer changes. */
	teamId?: string;
	version?: number;
	actor?: DeployActor;
}

/** Body of `deploy.publish()`. */
export interface PublishResult {
	artifact?: DeployArtifact;
	/** Present only when `deployTo` was given (one-step publish+deploy). */
	deployment?: Deployment;
}

/** The standard list-API request arguments (page/search/filter/sort). */
export interface DeployListParams {
	/** 1-based page number. */
	page?: number;
	/** Rows per page (server-clamped). */
	pageSize?: number;
	/** Free-text search over the surface's searchable columns. */
	search?: string;
	/** Column filters; `__gte`/`__lte` suffixes express range bounds. */
	filters?: Record<string, unknown>;
	/** Sorters, most-significant first. */
	sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
}

/** The standard list envelope. */
export interface DeployListEnvelope<T> {
	rows: T[];
	total: number;
	page: number;
	pageSize: number;
}

/** Body of `deploy.preview()` — THE single cron evaluator. */
export interface SchedulePreview {
	valid?: boolean;
	/** Human-readable reason when invalid. */
	error?: string;
	/** Unix timestamps (seconds) of the next occurrences. */
	next?: number[];
}
