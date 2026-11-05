// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER — TYPES (the contract every Explorer app compiles in)
// =============================================================================
//
// Shared by SQL Explorer, Graph Explorer and Vector Explorer. This module is
// TYPES AND CONSTANTS ONLY and imports nothing from 'shell', so it loads under
// node:test with or without the platform stub.
//
// The library is compiled INTO each app (factories, no module-level state, no
// Module Federation singleton). Contract revision: v1 (explorer-foundation).
//
// SECRETS: a task token is a credential. It appears in exactly one place in
// this file — IExplorerTaskRow, the raw row discovery reads — and nowhere in
// any type an app, a store snapshot, a document payload or a preference ever
// holds. IExplorerEndpoint is JSON-safe to log, copy, persist and put in a URL
// by construction.
// =============================================================================

import type { ExplorerErrorKind } from './errors';

// =============================================================================
// CLIENT (structural, so pure modules need no 'shell' import)
// =============================================================================

/**
 * The slice of the shell's RocketRideClient the Explorer library calls.
 * RocketRideClient satisfies it structurally; tests pass a fake.
 */
export interface IExplorerClient {
	/** Running tasks visible to the caller, each with its OWN token (rrext_get_tasks). */
	getTasks(): Promise<Array<Record<string, unknown>>>;
	/**
	 * One page of the caller's tasks (rrext_list_tasks). Discovery reads only
	 * their display names from it (`{task name}.{source component name}`),
	 * never which tasks exist; optional, and a failure only costs those names.
	 */
	listTasks?(req: { page_size?: number; filters?: Record<string, string | string[]>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }> }): Promise<unknown>;
	/** The task's pipeline (only needed when a task row carries no components). */
	getTaskPipeline(token: string): Promise<Record<string, unknown> | undefined>;
	/** Invoke a node tool through the task's token. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tool<T = any>(options: { token: string; tool: string; nodeId?: string; input?: Record<string, unknown>; timeout?: number }): Promise<T>;
	/** Ref-counted server-event subscription (only the shell binding calls this). */
	addMonitor?(key: { token?: string; projectId?: string; source?: string }, types: string[]): Promise<void>;
	/** Counterpart of addMonitor. */
	removeMonitor?(key: { token?: string; projectId?: string; source?: string }, types: string[]): Promise<void>;
	/**
	 * Upload files into a task's data lane (the dropper path). Only the role
	 * channel of a multi-role connection calls this (Vector Explorer's ingest).
	 * Resolves with one upload result per file. Typed `object` because the SDK's
	 * UPLOAD_RESULT has no index signature: the role channel copies each result
	 * into a plain record (`IRoleChannel.sendFiles`), so apps never see this type.
	 */
	sendFiles?(files: ISendFile[], token: string, maxConcurrent?: number): Promise<object[]>;
	/** Ask a chat source a question. Only the role channel of a multi-role connection calls this. */
	chat?(options: { token: string; question: unknown; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> }): Promise<Record<string, unknown>>;
}

/** One file for {@link IExplorerClient.sendFiles}. */
export interface ISendFile {
	/** The file. */
	file: File;
	/** Object info sent with it (for example `{ name, origin }`). */
	objinfo?: Record<string, unknown>;
	/** MIME type; the SDK falls back to the file's own type. */
	mimetype?: string;
}

// =============================================================================
// TASK ROWS (what rrext_get_tasks returns)
// =============================================================================

/** A component of a pipeline, the subset discovery needs. */
export interface IExplorerComponent {
	/** Component id (the tool-call target). */
	id?: string;
	/** Component provider id, e.g. 'db_postgres', 'graph_neo4j'. */
	provider?: string;
	/** Optional display name. */
	name?: string;
	/**
	 * Control edges into this component (`{ from: <source id>, classType: 'tool' }`).
	 * Discovery reads them to tell which nodes a Tools source controls. Never
	 * the component's config.
	 */
	control?: ReadonlyArray<{ from?: string; classType?: string }>;
}

/**
 * The project dict a task row carries (control.pipeline on the server).
 *
 * Project identity is `project_id` (snake_case). A pipeline launched WITHOUT
 * one gets a random uuid on the server that getTasks never exposes, so
 * `project_id` may legitimately be absent — see {@link IExplorerEndpoint.projectId}.
 */
export interface IExplorerPipeline {
	/** Project identity; absent when the pipeline was launched without one. */
	project_id?: string;
	/** Pipeline display name. */
	name?: string;
	/** The pipeline's components. */
	components?: IExplorerComponent[];
}

/**
 * One element of `client.getTasks()` as the server sends it (RUNNING tasks
 * only; one task per source of a project). `token` is a SECRET: discovery
 * reads it into the store's transient vault and never copies it anywhere else.
 */
export interface IExplorerTaskRow {
	/** Task display name. */
	name: string;
	/** Pipeline description. */
	description: string;
	/** Source component id of THIS task. */
	source: string;
	/** SECRET task token. */
	token: string;
	/** Server status string, e.g. 'Tools ready - system is ready to accept tool calls'. */
	status: string;
	/** Owning/billing team id ('' when none). */
	teamId: string;
	/** 'dev' | 'deploy'. */
	runKind: string;
	/** 'user' | 'team'. */
	ownerKind: string;
	/** The owner's id (user id or team id per ownerKind). */
	ownerId: string;
	/** The project dict (see {@link IExplorerPipeline}). */
	pipeline: IExplorerPipeline | null;
}

/**
 * One task named by what it runs, never by its token: its pipeline's project
 * id and its source component id. A task lifecycle event names a task this
 * way, and discovery reports the running tasks this way.
 */
export interface ITaskRef {
	/** `pipeline.project_id` ('' when the pipeline has none). */
	projectId: string;
	/** The task's source component id. */
	source: string;
}

// =============================================================================
// IDENTITY
// =============================================================================

/**
 * Who is signed in, reduced to what decides whether cached state is still
 * valid. Never contains a token. A change in ANY field resets the store.
 */
export interface IExplorerIdentity {
	/** The user id. */
	userId: string;
	/** The selected organization id ('' when none). */
	orgId: string;
	/** The user's development team id ('' when none). */
	devTeam: string;
	/**
	 * Permissions the user holds per team (team id -> permission strings), when
	 * known. The permissions are a HINT only, used to label a failed probe as
	 * `inaccessible`: they never decide whether a call is attempted, and a
	 * change in them does not reset the store (only the three fields above do).
	 * The KEYS are the signed-in organization's teams, and discovery lists only
	 * runs of those teams (see connect/identity.ts `runInIdentityOrganization`).
	 */
	teamPermissions?: Readonly<Record<string, readonly string[]>>;
	/** Organization-level permissions, when known (same hint-only status). */
	orgPermissions?: readonly string[];
}

// =============================================================================
// ROLES
// =============================================================================

/** One role a connection is made of. */
export interface IRoleDef {
	/** Source component ids that fill the role; null = ANY source (single-role SQL/Graph). */
	sources: readonly string[] | null;
	/**
	 * Source providers that also fill the role: a row fills it when its own
	 * source component (the component whose id is the row's `source`, read from
	 * the row's `pipeline.components`) has one of these providers. A source the
	 * role names in `sources` is preferred over a provider match. A role with
	 * providers keys on a fixed `~provider+provider` marker (see keys.ts), so the
	 * connection's key does not depend on which source fills it.
	 */
	providers?: readonly string[];
	/** A required role that is not running makes the endpoint 'stopped' (it cannot be called). */
	required: boolean;
}

/**
 * The role map a connection is discovered over. SQL and Graph pass one role;
 * Vector passes three (ingest_1, chat_1, tools_1 of ONE project, owner and
 * run context). Different owners, teams or run kinds never merge.
 */
export interface IRoleSpec {
	/** Role name -> definition. */
	roles: Readonly<Record<string, IRoleDef>>;
	/** The role whose task token carries tool calls. */
	toolsRole: string;
	/**
	 * Roles that may anchor a READ-ONLY connection when the tools role is not
	 * running, in order: the first bound one carries the connection's calls
	 * (its token is the endpoint's token) and the endpoint is `readOnly`.
	 * Without it, a connection whose tools role is not running has no token.
	 */
	readOnlyAnchors?: readonly string[];
}

/** SQL Explorer and Graph Explorer: one `tools` role filled by any source. */
export const SINGLE_TOOLS_ROLE: IRoleSpec = {
	roles: { tools: { sources: null, required: true } },
	toolsRole: 'tools',
};

/**
 * Vector Explorer's three-source connection: an ingest source (dropper or
 * webhook), a chat source and a Tools source of ONE project. Every role is
 * optional and matched by its source's provider too, so a stock RAG pipeline
 * (webhook + chat, no Tools source) still becomes a connection: a read-only one
 * anchored on its chat source, or on its ingest source when chat is not running.
 */
export const VECTOR_ROLES: IRoleSpec = {
	roles: {
		ingest: { sources: ['ingest_1'], providers: ['dropper', 'webhook'], required: false },
		chat: { sources: ['chat_1'], providers: ['chat'], required: false },
		tools: { sources: ['tools_1'], providers: ['tools'], required: false },
	},
	toolsRole: 'tools',
	readOnlyAnchors: ['chat', 'ingest'],
};

// =============================================================================
// ENDPOINT
// =============================================================================

/**
 * Where an endpoint is in its life.
 *
 * - `probing`      — discovered, the one-per-endpoint dialect probe is pending.
 * - `ready`        — the probe answered.
 * - `stopped`      — its task is not running (it vanished from getTasks, or a
 *                    required role is missing). It is kept so an open workbench
 *                    can say so instead of failing on first use.
 * - `unreachable`  — running, but the probe could not reach the node (not wired
 *                    to a tools source, node error, timeout).
 * - `inaccessible` — running, but the caller may not call it (a team
 *                    deployment seen with task.monitor only).
 */
export type EndpointState = 'probing' | 'ready' | 'stopped' | 'unreachable' | 'inaccessible';

/** One role's binding inside an endpoint — a source id, never a token. */
export interface IRoleBinding {
	/** The source component id that fills the role. */
	source: string;
}

/**
 * One reachable tool node inside a running project — the unit a "connection"
 * binds to. Purely descriptive and JSON-safe: it holds NO token and no client
 * state, so it may ride in document payloads, logs and copied JSON.
 */
export interface IExplorerEndpoint {
	/**
	 * Owner-aware identity: `k1|runKind|ownerKind|ownerId|teamId|projectId|role=source,…|nodeId`,
	 * every field percent-encoded (the key never contains a raw ':' or '|').
	 * See keys.ts.
	 */
	key: string;
	/**
	 * SQL Explorer's pre-v1 key `${projectId}:${source}:${nodeId}`. Set ONLY for
	 * the caller's own dev run (all the old token lookup could ever open) so
	 * saved history is never read across owners or dev/deploy; null otherwise.
	 */
	legacyKey: string | null;
	/**
	 * `pipeline.project_id`, or '' when the pipeline carries none. A task
	 * launched without one gets a random id the server never reports, and
	 * deriving one from the token would put a credential-derived value in a key;
	 * so two pipelines of the same owner and run kind that both lack a
	 * project_id and share a source and node id are indistinguishable. Real
	 * .pipe files carry a project_id, so this is a documented limitation, not a
	 * supported setup.
	 */
	projectId: string;
	/** Task display name (pipeline name). */
	pipelineName: string;
	/** 'dev' | 'deploy'. */
	runKind: string;
	/** Who owns the run. */
	ownerKind: 'user' | 'team';
	/** The owner's id. */
	ownerId: string;
	/** The task's owning/billing team id ('' when none). */
	teamId: string;
	/** Role -> binding; null = the role is NOT running (never borrowed from another run). */
	roles: Readonly<Record<string, IRoleBinding | null>>;
	/** Names of the roles that are not running. */
	missingRoles: readonly string[];
	/** The tools role's source id ('' when that role is missing). */
	source: string;
	/** The tool node's component id (the tool-call target). */
	nodeId: string;
	/** Display name of the node (falls back to nodeId). */
	nodeName: string;
	/** Component provider, e.g. 'db_postgres', 'graph_neo4j'. */
	provider: string;
	/** Where the endpoint is in its life. */
	state: EndpointState;
	/** Safe human text explaining a non-ready state; never a token, DSN or credential. */
	stateDetail?: string;
	/** Legacy flag: true while the state is `probing` or `ready`. */
	running: boolean;
	/**
	 * The pipeline's components (id, provider, name and control edges only;
	 * never config, never input edges). Set on every endpoint discovered over a
	 * MULTI-role spec; absent on single-role (SQL, Graph) endpoints, whose
	 * snapshots, payloads and documents stay exactly as they were. Narrow with
	 * `isMultiRoleEndpoint` (connect/discovery.ts) to read it as required.
	 */
	components?: ReadonlyArray<IExplorerComponent>;
	/** The role whose task token this endpoint's calls use (multi-role only; see `components`). */
	anchorRole?: string;
	/** True when the endpoint is anchored on a role other than the tools role (multi-role only; see `components`). */
	readOnly?: boolean;
}

/**
 * An endpoint discovered over a multi-role spec (Vector Explorer): the three
 * connection fields are always present. Discovery fills them for every
 * multi-role endpoint and never for a single-role one.
 */
export type IMultiRoleEndpoint = IExplorerEndpoint & {
	/** The pipeline's components (id, provider, name and control edges only). */
	components: ReadonlyArray<IExplorerComponent>;
	/** The role whose task token this endpoint's calls use. */
	anchorRole: string;
	/** True when the endpoint is anchored on a role other than the tools role. */
	readOnly: boolean;
};

/** Result of the one-per-endpoint probe. */
export interface IProbeResult {
	/** Whether the node answered. */
	ok: boolean;
	/** The node's `dialect` answer (engine, version, database, graph, allow_execute, capabilities, limits…), validated to be an object. */
	info: Record<string, unknown> | null;
	/** `info.dialect` when it is a string. */
	dialect: string | null;
	/** Why the probe failed. */
	error?: { kind: ExplorerErrorKind; message: string; code?: string };
}
