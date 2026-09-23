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
	/** Paused schedules stay configured (cron/ttl kept) but never fire. */
	paused?: boolean;
	/** Run window in seconds ('fixed window'); null/absent = until finished. */
	ttl?: number | null;
	/** Trace verbosity for this source's deploy runs; null/absent = the
	    deploy default (full). */
	traceLevel?: 'none' | 'metadata' | 'summary' | 'full' | null;
	/** Full task debug output (--trace=debugOut) for this source. */
	debugOut?: boolean;
	/** Unix timestamp (seconds) of the last scheduler dispatch, or null. */
	lastRunAt?: number | null;
}

/** One team's deployment of a project, joined with registry info. */
export interface Deployment {
	teamId?: string;
	projectId?: string;
	/** The registry version this team currently points at. */
	version?: number;
	/** `disabled` is the whole-deployment kill switch — nothing runs. */
	state?: 'enabled' | 'disabled' | 'errored' | 'removed';
	pipelineName?: string;
	/** Per-source schedules, keyed by source id. */
	schedules?: Record<string, DeploymentSchedule>;
	createdAt?: number;
	createdBy?: DeployActor;
	updatedAt?: number;
	updatedBy?: DeployActor;
	/** Unix seconds of the latest POINTER MOVE for this team (deploy or
	    rollback), computed from the audit trail — unlike `updatedAt`, it is
	    NOT bumped by disable/enable or schedule edits. */
	deployedAt?: number;
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
	/** `pause`/`resume` appear only on rows written before the
	    enable/disable vocabulary (the trail is immutable). NOTE: app rails
	    additionally carry the review vocabulary (`request`/`approved`/
	    `rejected`/`withdrawn`/`failed`) and the human `reply` row at runtime —
	    the union names the pipe-rail actions only and stays as the frozen
	    v1.3 floor wrote it (widening a returned union would break floor
	    assignability); compare raw strings for the app-rail extras. */
	action?: 'publish' | 'deploy' | 'rollback' | 'enable' | 'disable' | 'pause' | 'resume' | 'errored' | 'remove';
	/** `''` on org-wide rows (publish); the team id on pointer changes. */
	teamId?: string;
	version?: number;
	actor?: DeployActor;
	/** Row payload — self-describing by contract (rows render without a
	    second lookup). `reply` rows carry the review-thread message and its
	    side. App audience rows (publish binds, removed/disabled/enabled)
	    carry the audience WITH its server-dereferenced display facts
	    (`name`, `handle`), plus `previousVersion` when a publish repointed
	    an existing binding. A `publish` row without an audience is the
	    registry write (the DEPLOY) and rides the deploy `comment`; review
	    transitions carry both endpoints (`from`/`to`). */
	data?: {
		side?: 'admin' | 'developer';
		message?: string;
		audience?: { type?: string; id?: string; name?: string; handle?: string };
		previousVersion?: number;
		comment?: string;
		from?: string;
		to?: string;
	} | null;
}

/** Body of `deploy.add()` — the generic rail door. */
export interface PublishResult {
	artifact?: DeployArtifact;
	/** Present only when `deployTo` was given (one-step add+deploy; pipes only). */
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
