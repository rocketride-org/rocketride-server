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
// EXPLORER CONNECT — DISCOVERY (find tool nodes in running pipelines)
// =============================================================================
//
// Discovery reads `client.getTasks()`: the RUNNING tasks the caller may see,
// each with its OWN token, team, run kind and owner, in one call. That fixes
// four limits of the page-and-lookup approach it replaces:
//
//   - the old listing stopped at one page of 100, oldest first; getTasks is
//     not paged, so the newest running pipelines are not missing;
//   - the old token lookup sent no team and resolved only the caller's own dev
//     run, so a team deployment failed to open (or, worse, the caller's own run
//     of the same project opened in its place); getTasks hands over each run's
//     own token, so no lookup happens at all;
//   - a developer's run and the team's deployment of one pipeline collided on
//     one key; the key now carries run kind, owner and team (see keys.ts);
//   - a task row already carries `pipeline.components`, so no per-task
//     pipeline fetch is needed (getTaskPipeline is only a fallback, bounded).
//
// A connection is a ROLE MAP, not a provider set: SQL and Graph pass one
// `tools` role filled by any source; Vector passes ingest / chat / tools roles,
// each filled by its declared source id (`ingest_1`, `chat_1`, `tools_1`) or by
// a source of the role's providers (a `webhook` source fills ingest), grouped
// into ONE connection per project, owner and run context. Runs of different
// owners, teams or run kinds never merge, and a missing role is reported as
// missing — never borrowed from another run.
//
// ANCHOR: the role whose token carries a connection's calls. It is the tools
// role when a tools source runs; otherwise the first running role of the spec's
// `readOnlyAnchors`, and the endpoint is then READ-ONLY (Vector's stock RAG
// pipeline: webhook + chat, no Tools source, still opens as a card).
//
// MULTI-ROLE ENDPOINTS also carry the pipeline's components (id, provider,
// name and control edges; never config), their anchor role and the read-only
// flag. Single-role (SQL, Graph) endpoints carry none of the three, so their
// snapshots and document payloads are exactly what they were.
//
// NAMES: getTasks names a run by its pipeline's name, or by its source id when
// the pipeline has none. The readable name #2625 shows ("Shop Postgres.Tools",
// `{task name}.{source component name}`) is the task's status name, and only
// `listTasks` carries it. So discovery also asks `listTasks` ONCE, alongside
// getTasks, for the newest 100 live tasks, and uses it for NAMES ONLY: which
// endpoints exist, their keys and their tokens all come from getTasks.
//
// A listTasks row is matched to EXACTLY one run, by the run's display id,
// built here, in memory, the way the server builds it (listTasks rows carry
// no owner or team, so nothing else tells two teams' deployments of one
// project apart). A run started without a task name (every deploy) has a
// status name made from that id, which is not a readable name, so it is not
// used. A run listTasks does not name (not among those 100, no task name, or
// listTasks failed or took longer than its own timeout) is named by its
// pipeline's name, then its source component's name, then its source id. A
// role map takes the name of its tools run only, so the label does not change
// with which run anchors the connection.
//
// TOKENS: a task token is read here and returned beside the endpoint, never
// inside it: `token` (the anchor role's) and `roleTokens` (every running
// role's). The caller (the store) puts them in its transient vaults; nothing
// else in the library ever sees them.
//
// ANOTHER ORGANIZATION'S RUNS: getTasks also returns the caller's own runs
// started in an organization they have since switched away from (the server
// scopes a user-owned run by its owner, not by the current organization).
// Such a row is dropped here, before grouping, when the identity lists its
// organization's teams and the row's team is not one of them, so neither its
// card nor its token reaches the store (see identity.ts).
// =============================================================================

import { isPlainObject } from '../checks';
import { buildEndpointKey, legacyKeyFromKey, roleKeySource } from '../keys';
import type { IExplorerClient, IExplorerComponent, IExplorerEndpoint, IExplorerIdentity, IExplorerPipeline, IExplorerTaskRow, IMultiRoleEndpoint, IRoleBinding, IRoleDef, IRoleSpec, ITaskRef } from '../types';
import { identityCanCallTools, runInIdentityOrganization } from './identity';

// =============================================================================
// CONSTANTS
// =============================================================================

/** `stateDetail` of an endpoint anchored on a role other than the tools role. */
export const READ_ONLY_DETAIL = 'Read-only: no Tools source is running';

// =============================================================================
// TYPES
// =============================================================================

/**
 * What a node filter is told about the connection a component belongs to.
 * Frozen: one description serves every component of the group.
 */
export interface INodeFilterGroup {
	/** The running source that fills the tools role, or null when none runs. */
	readonly toolsSource: string | null;
	/**
	 * Every component of the pipeline that could fill the tools role (a declared
	 * tools source id, or a source of a tools provider), running or not, in
	 * pipeline order. Empty when the pipeline has no Tools source at all.
	 */
	readonly toolsSources: readonly string[];
	/** The role whose token carries the connection's calls. */
	readonly anchorRole: string;
	/** The running roles, in spec order. */
	readonly boundRoles: readonly string[];
}

/** Decides whether one matching component of a connection becomes an endpoint. */
export type NodeFilter = (component: IExplorerComponent, group: INodeFilterGroup) => boolean;

/**
 * The node filter Vector Explorer uses: the nodes a Tools source controls.
 *
 * - A Tools source runs: only the nodes it controls (`component.control` has
 *   an edge from it), so the chat path's second store never becomes a card.
 * - The pipeline has a Tools source that is not running (read-only): the
 *   nodes any of its Tools components controls. The card is the one the
 *   callable connection shows, under the same key; the chat path's store
 *   still never appears.
 * - The pipeline has no Tools source at all (stock RAG): every node.
 *
 * @param component - The component, as the endpoint will carry it.
 * @param group - The connection it belongs to.
 * @returns True when the component becomes an endpoint.
 */
export function controlledByTools(component: IExplorerComponent, group: INodeFilterGroup): boolean {
	const edges = component.control ?? [];
	if (group.toolsSource !== null) return edges.some((edge) => edge.from === group.toolsSource);
	if (group.toolsSources.length === 0) return true;
	return edges.some((edge) => edge.from !== undefined && group.toolsSources.includes(edge.from));
}

/** What discovery needs to know. */
export interface IDiscoveryOptions {
	/** Component provider ids that are tool nodes for this app. */
	providers: ReadonlySet<string>;
	/** The role map a connection is made of. */
	roles: IRoleSpec;
	/** Who is signed in (used only to hint `inaccessible`); optional. */
	identity?: IExplorerIdentity | null;
	/** Concurrency of the getTaskPipeline fallback (default 4). */
	concurrency?: number;
	/** How long to wait for listTasks's names (default {@link TASK_NAMES_TIMEOUT_MS}). */
	taskNamesTimeoutMs?: number;
	/**
	 * Which components of the app's providers become endpoints (default: all).
	 * Called with the component as the endpoint will carry it (id, provider,
	 * name, control edges) and a frozen description of its connection (see
	 * {@link INodeFilterGroup}). Vector passes {@link controlledByTools}, so the
	 * chat path's second store never becomes a card, running Tools source or not.
	 */
	nodeFilter?: NodeFilter;
	/**
	 * Told once per discovery, after the task listing answered, which tasks are
	 * running: every usable row (one with a token and a source) as its project
	 * id and source, never its token, in listing order. A row counts whether
	 * or not it becomes an endpoint (another app's pipeline, the caller's own
	 * run in another organization). The store uses it to stop looking for a
	 * task whose start was announced before it ran (see store.ts, "WHEN IT
	 * REFRESHES"). Not called when the task listing fails.
	 */
	onRunning?: (running: readonly ITaskRef[]) => void;
}

/** One discovered endpoint, with the secret that belongs in the vault. */
export interface IDiscoveredEndpoint {
	/** The token-free endpoint. */
	endpoint: IExplorerEndpoint;
	/** The anchor role's task token (the tools role's, unless read-only) — for the store's transient vault ONLY. */
	token: string | null;
	/** Whether the identity can tell the caller may invoke tools (hint; undefined = unknown). */
	callHint: boolean | undefined;
	/** Role -> that role's task token, running roles only — for the store's role vault ONLY. */
	roleTokens: Readonly<Record<string, string>>;
	/** The role whose token is `token`. */
	anchorRole: string;
}

/**
 * Whether an endpoint was discovered over a multi-role spec, so its
 * `components`, `anchorRole` and `readOnly` are present.
 *
 * @param endpoint - The endpoint.
 * @returns True for a multi-role (Vector) endpoint.
 */
export function isMultiRoleEndpoint(endpoint: IExplorerEndpoint): endpoint is IMultiRoleEndpoint {
	return Array.isArray(endpoint.components) && typeof endpoint.anchorRole === 'string' && typeof endpoint.readOnly === 'boolean';
}

// =============================================================================
// ROW READING
// =============================================================================

/**
 * Narrow one raw `getTasks` element. The data arrives from the network and may
 * come from a newer or older server, so nothing is trusted: a row without a
 * token or a source is not usable and is dropped.
 *
 * @param raw - One element of the getTasks array.
 * @returns The row, or null when it cannot be used.
 */
export function readTaskRow(raw: unknown): IExplorerTaskRow | null {
	if (!isPlainObject(raw)) return null;
	const source = typeof raw.source === 'string' ? raw.source : '';
	const token = typeof raw.token === 'string' ? raw.token : '';
	if (source === '' || token === '') return null;
	const pipeline = isPlainObject(raw.pipeline) ? (raw.pipeline as IExplorerPipeline) : null;
	return {
		name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : source,
		description: typeof raw.description === 'string' ? raw.description : '',
		source,
		token,
		status: typeof raw.status === 'string' ? raw.status : '',
		teamId: typeof raw.teamId === 'string' ? raw.teamId : '',
		runKind: typeof raw.runKind === 'string' && raw.runKind !== '' ? raw.runKind : 'dev',
		ownerKind: typeof raw.ownerKind === 'string' ? raw.ownerKind : '',
		ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
		pipeline,
	};
}

/**
 * The project id a row carries, or '' when the pipeline has none.
 *
 * @param row - The task row.
 * @returns `pipeline.project_id`, or ''.
 */
function projectIdOf(row: IExplorerTaskRow): string {
	const id = row.pipeline?.project_id;
	return typeof id === 'string' ? id : '';
}

/**
 * The owner kind of a row, normalised. The server stamps `ownerKind`; an
 * older server that does not is read the way its own default reads: a deploy
 * is team-owned, anything else user-owned.
 *
 * @param row - The task row.
 * @returns 'user' or 'team'.
 */
function ownerKindOf(row: IExplorerTaskRow): 'user' | 'team' {
	if (row.ownerKind === 'team' || row.ownerKind === 'user') return row.ownerKind;
	return row.runKind === 'deploy' ? 'team' : 'user';
}

// =============================================================================
// READABLE NAMES (one listTasks per discovery; names only)
// =============================================================================

/**
 * How long discovery waits for `listTasks`. It is asked together with
 * getTasks, so the wait overlaps the list call; the store's discovery bound
 * (30 s) stays the deadline, and a slow or failed `listTasks` costs only the
 * readable names.
 */
export const TASK_NAMES_TIMEOUT_MS = 10_000;

/** The one `listTasks` request: the newest 100 live tasks (the server pages at 100). */
export const TASK_NAMES_REQUEST: Parameters<NonNullable<IExplorerClient['listTasks']>>[0] = {
	page_size: 100,
	filters: { completed: 'false' },
	sort: [{ field: 'startTime', dir: 'desc' }],
};

/** TASK_STATE.STOPPING: a row at or past it is no longer a live run. */
const TASK_STATE_STOPPING = 4;

/** Clients whose listTasks failure is already logged (one line per client, not per discovery). */
const namesFailureLogged = new WeakSet<IExplorerClient>();

/**
 * A run's display id, built the way the server builds it (task_server.py).
 * Kept in memory only, to match a listTasks row to its run.
 *
 * @param row - The getTasks row.
 * @returns The id.
 */
function runIdOf(row: IExplorerTaskRow): string {
	return `${row.token.replace(/^(tk_|pk_)/, '').slice(0, 8)}.${row.source}`;
}

/**
 * Read the display names a `listTasks` answer gives live runs, by display id.
 * A run started without a task name (`{display id}.{component}`) names
 * nothing, and an id whose live rows disagree maps to null.
 *
 * @param answer - The listTasks answer (`{ rows, … }`); anything else names nothing.
 * @returns Name by display id.
 */
function readTaskNames(answer: unknown): Map<string, string | null> {
	const names = new Map<string, string | null>();
	const rows = isPlainObject(answer) && Array.isArray(answer.rows) ? (answer.rows as unknown[]) : [];
	for (const raw of rows) {
		if (!isPlainObject(raw) || raw.completed === true) continue;
		if (typeof raw.state === 'number' && raw.state >= TASK_STATE_STOPPING) continue;
		const { id, name } = raw;
		if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '' || name.startsWith(`${id}.`)) continue;
		const earlier = names.get(id);
		names.set(id, earlier === undefined || earlier === name ? name : null);
	}
	return names;
}

/**
 * Ask `listTasks` for the names, within its own timeout. Never throws, never
 * waits longer than `timeoutMs`, and logs a failure once per client.
 *
 * @param client - The client (one without listTasks names nothing).
 * @param timeoutMs - The wait.
 * @returns Name by display id; empty when listTasks could not answer.
 */
async function fetchTaskNames(client: IExplorerClient, timeoutMs: number): Promise<Map<string, string | null>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const list = client.listTasks;
		if (typeof list !== 'function') return new Map();
		const answer = await Promise.race([
			Promise.resolve().then(() => list.call(client, TASK_NAMES_REQUEST)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`listTasks did not answer within ${timeoutMs} ms.`)), timeoutMs);
			}),
		]);
		return readTaskNames(answer);
	} catch (error) {
		if (!namesFailureLogged.has(client)) {
			namesFailureLogged.add(client);
			console.warn('[explorer] Pipeline names from listTasks are unavailable; naming connections by pipeline and source instead.', error);
		}
		return new Map();
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * The display name of a connection: listTasks's name for its tools run when it
 * has one, else, from the anchor row, the pipeline's name (getTasks's own name
 * when that is more than the source id, which is what the server sends then),
 * the source component's name, or the source id.
 *
 * @param toolsRow - The tools role's run (null while it is not running).
 * @param row - The anchor row.
 * @param components - The pipeline's components.
 * @param names - listTasks's names, by display id.
 * @returns The name.
 */
function displayNameOf(toolsRow: IExplorerTaskRow | null, row: IExplorerTaskRow, components: IExplorerComponent[], names: Map<string, string | null>): string {
	const listed = toolsRow ? names.get(runIdOf(toolsRow)) : undefined;
	if (typeof listed === 'string') return listed;
	// The server names a getTasks row `pipeline.name || source`.
	if (row.name !== row.source) return row.name;
	const pipelineName = row.pipeline?.name;
	if (typeof pipelineName === 'string' && pipelineName !== '') return pipelineName;
	// The engine names a status `{task}.{component name | config.name | source}`.
	const component: unknown = components.find((c) => c?.id === row.source);
	if (isPlainObject(component)) {
		if (typeof component.name === 'string' && component.name !== '') return component.name;
		const config = component.config;
		if (isPlainObject(config) && typeof config.name === 'string' && config.name !== '') return config.name;
	}
	return row.source;
}

// =============================================================================
// GROUPING
// =============================================================================

/** The rows of one connection, by role. */
interface IGroup {
	/** Role name -> the row filling it (null = not running). */
	byRole: Map<string, IExplorerTaskRow | null>;
	/** The role whose token carries the connection's calls. */
	anchorRole: string;
	/** The row that supplies the pipeline components and identity fields. */
	anchor: IExplorerTaskRow;
}

/**
 * The provider of a row's own source component, read from the components the
 * row carries (the server sends the whole pipeline on every row).
 *
 * @param row - The task row.
 * @returns The provider, or null when the row does not say.
 */
function sourceProviderOf(row: IExplorerTaskRow): string | null {
	const components = row.pipeline?.components;
	if (!Array.isArray(components)) return null;
	const own = components.find((component) => isPlainObject(component) && component.id === row.source);
	return own !== undefined && typeof own.provider === 'string' ? own.provider : null;
}

/**
 * How well a row fills a role: 2 = a declared source id, 1 = a source of one
 * of the role's providers, 0 = not at all.
 *
 * @param def - The role.
 * @param row - The row.
 * @returns The match rank.
 */
function fillRank(def: IRoleDef, row: IExplorerTaskRow): number {
	if (def.sources !== null && def.sources.includes(row.source)) return 2;
	if (def.providers !== undefined) {
		const provider = sourceProviderOf(row);
		if (provider !== null && def.providers.includes(provider)) return 1;
	}
	return 0;
}

/**
 * The role that anchors a connection: the tools role when it runs, else the
 * first running role of `readOnlyAnchors`, else the tools role (which then has
 * no token: nothing can be called).
 *
 * @param spec - The role spec.
 * @param byRole - Role name -> the row filling it.
 * @returns The anchor role.
 */
function anchorRoleOf(spec: IRoleSpec, byRole: Map<string, IExplorerTaskRow | null>): string {
	if (byRole.get(spec.toolsRole)) return spec.toolsRole;
	return spec.readOnlyAnchors?.find((role) => byRole.get(role)) ?? spec.toolsRole;
}

/**
 * The ids of a pipeline's components that could fill the tools role (a
 * declared source id, or a component of one of the role's providers), running
 * or not, in pipeline order; plus the running tools source when the role takes
 * any source (the single-role shape).
 *
 * @param spec - The role spec.
 * @param components - The pipeline's components (raw).
 * @param toolsRow - The row filling the tools role, or null.
 * @returns The ids, without duplicates.
 */
function toolsSourcesOf(spec: IRoleSpec, components: readonly unknown[], toolsRow: IExplorerTaskRow | null): string[] {
	const def = spec.roles[spec.toolsRole];
	const ids: string[] = [];
	for (const raw of components) {
		if (!isPlainObject(raw) || typeof raw.id !== 'string' || raw.id === '' || ids.includes(raw.id)) continue;
		const declared = def !== undefined && def.sources !== null && def.sources.includes(raw.id);
		const byProvider = def?.providers !== undefined && typeof raw.provider === 'string' && def.providers.includes(raw.provider);
		if (declared || byProvider) ids.push(raw.id);
	}
	if (toolsRow !== null && !ids.includes(toolsRow.source)) ids.push(toolsRow.source);
	return ids;
}

/**
 * Whether the spec is the single-role shape (one role, any source): each
 * running task is then its own connection.
 *
 * @param spec - The role spec.
 * @returns True for the SQL/Graph shape.
 */
function isSingleRole(spec: IRoleSpec): boolean {
	const names = Object.keys(spec.roles);
	return names.length === 1 && spec.roles[names[0] as string]?.sources === null;
}

/**
 * Group running task rows into connections.
 *
 * Single-role: one group per row. Multi-role: rows are grouped by run kind,
 * owner kind, owner id, team and project, then each role takes the row whose
 * source it names, else a row whose source component has one of the role's
 * providers (lowest source id first when several qualify). A row whose
 * pipeline carries no project id cannot be proven to belong to any other row's
 * project, so it is never grouped with another row.
 *
 * @param rows - The usable task rows.
 * @param spec - The role spec.
 * @returns The groups, each keeping the rows' original order.
 */
function groupRows(rows: IExplorerTaskRow[], spec: IRoleSpec): IGroup[] {
	const roleNames = Object.keys(spec.roles);
	if (isSingleRole(spec)) {
		return rows.map((row) => ({ byRole: new Map([[spec.toolsRole, row]]), anchorRole: spec.toolsRole, anchor: row }));
	}

	const buckets = new Map<string, IExplorerTaskRow[]>();
	rows.forEach((row, index) => {
		const project = projectIdOf(row);
		// No project id: unique bucket, so it never merges with another row.
		const bucketKey = project === ''
			? `~${index}`
			: [row.runKind, ownerKindOf(row), row.ownerId, row.teamId, project].map(encodeURIComponent).join('|');
		const bucket = buckets.get(bucketKey);
		if (bucket) bucket.push(row);
		else buckets.set(bucketKey, [row]);
	});

	const groups: IGroup[] = [];
	for (const bucket of buckets.values()) {
		const byRole = new Map<string, IExplorerTaskRow | null>();
		let matched = 0;
		for (const role of roleNames) {
			const def = spec.roles[role]!;
			// A declared source id beats a provider match; then the lowest source id.
			const candidates = bucket
				.map((row) => ({ row, rank: fillRank(def, row) }))
				.filter((candidate) => candidate.rank > 0)
				.sort((a, b) => b.rank - a.rank || a.row.source.localeCompare(b.row.source));
			byRole.set(role, candidates[0]?.row ?? null);
			if (candidates[0]) matched += 1;
		}
		// A project none of whose running sources fills a role is not this app's.
		if (matched === 0) continue;
		const anchorRole = anchorRoleOf(spec, byRole);
		const anchor = byRole.get(anchorRole) ?? [...byRole.values()].find((row): row is IExplorerTaskRow => row !== null)!;
		groups.push({ byRole, anchorRole, anchor });
	}
	return groups;
}

// =============================================================================
// DISCOVERY
// =============================================================================

/**
 * Run `work` over `items` with at most `limit` in flight, preserving order.
 *
 * @param items - The inputs.
 * @param limit - Maximum concurrent calls (at least 1).
 * @param work - The async mapper; must not throw (callers catch inside).
 * @returns The results in input order.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await work(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Read the components of a group's pipeline: from the task row when it carries
 * them, otherwise through `getTaskPipeline` (a bounded fallback).
 *
 * @param client - The client.
 * @param group - The group.
 * @returns The components, or null when they cannot be read.
 */
async function componentsOf(client: IExplorerClient, group: IGroup): Promise<IExplorerComponent[] | null> {
	const embedded = group.anchor.pipeline?.components;
	if (Array.isArray(embedded)) return embedded;
	try {
		const pipeline = await client.getTaskPipeline(group.anchor.token);
		const components = isPlainObject(pipeline) ? pipeline.components : undefined;
		return Array.isArray(components) ? (components as IExplorerComponent[]) : null;
	} catch {
		// One unreadable task must not break discovery of the rest.
		return null;
	}
}

/**
 * The slice of a component an endpoint may carry: id, provider, name and the
 * control edges' `from` / `classType`. Everything else (config, input edges,
 * UI state) is left behind, because endpoints are persisted and logged.
 *
 * @param raw - One element of the pipeline's components.
 * @returns The slice, or null when the element has no string id.
 */
function safeComponent(raw: unknown): IExplorerComponent | null {
	if (!isPlainObject(raw) || typeof raw.id !== 'string' || raw.id === '') return null;
	const component: { id: string; provider?: string; name?: string; control?: Array<{ from?: string; classType?: string }> } = { id: raw.id };
	if (typeof raw.provider === 'string') component.provider = raw.provider;
	if (typeof raw.name === 'string') component.name = raw.name;
	if (Array.isArray(raw.control)) {
		const edges: Array<{ from?: string; classType?: string }> = [];
		for (const edge of raw.control) {
			if (!isPlainObject(edge)) continue;
			const copy: { from?: string; classType?: string } = {};
			if (typeof edge.from === 'string') copy.from = edge.from;
			if (typeof edge.classType === 'string') copy.classType = edge.classType;
			if (copy.from !== undefined || copy.classType !== undefined) edges.push(copy);
		}
		component.control = edges;
	}
	return component;
}

/**
 * How strongly an endpoint claims a key that two groups share (only groups
 * whose rows carry no project id can): a callable endpoint beats a read-only
 * one, which beats a stopped one.
 *
 * @param endpoint - The endpoint.
 * @returns The rank.
 */
function claimRank(endpoint: IExplorerEndpoint): number {
	if (endpoint.state === 'stopped') return 0;
	return endpoint.readOnly === true ? 1 : 2;
}

/**
 * Discover every tool node reachable through the caller's running tasks.
 *
 * Throws only when the initial `getTasks` fails; everything after it is
 * per-task and per-group and never aborts discovery of the rest.
 *
 * @param client - The shell's RocketRide client.
 * @param options - Providers, role map, identity and node filter.
 * @returns Endpoints (state `probing`, or `stopped` when a required role is not running), sorted by pipeline name, node id, key.
 */
export async function discoverToolEndpoints(client: IExplorerClient, options: IDiscoveryOptions): Promise<IDiscoveredEndpoint[]> {
	// Asked first, so its wait overlaps getTasks; it never throws.
	const names = fetchTaskNames(client, options.taskNamesTimeoutMs ?? TASK_NAMES_TIMEOUT_MS);
	const raw = await client.getTasks();
	const identity = options.identity ?? null;
	const usable = (Array.isArray(raw) ? raw : []).map(readTaskRow).filter((row): row is IExplorerTaskRow => row !== null);
	options.onRunning?.(usable.map((row) => ({ projectId: projectIdOf(row), source: row.source })));
	const rows = usable.filter((row) => runInIdentityOrganization(identity, row.teamId));
	const multiRole = !isSingleRole(options.roles);
	const groups = groupRows(rows, options.roles);
	const componentLists = await mapWithConcurrency(groups, options.concurrency ?? 4, (group) => componentsOf(client, group));
	const taskNames = await names;

	const seen = new Map<string, number>();
	const found: IDiscoveredEndpoint[] = [];
	groups.forEach((group, groupIndex) => {
		const components = componentLists[groupIndex];
		if (!components) return;
		const toolsRow = group.byRole.get(options.roles.toolsRole) ?? null;
		const { anchor, anchorRole } = group;
		const anchorRow = group.byRole.get(anchorRole) ?? null;
		const readOnly = anchorRole !== options.roles.toolsRole;
		const ownerKind = ownerKindOf(anchor);
		const projectId = projectIdOf(anchor);

		const roles: Record<string, IRoleBinding | null> = {};
		const keyRoles: Record<string, string> = {};
		const roleTokens: Record<string, string> = {};
		const missingRoles: string[] = [];
		const boundRoles: string[] = [];
		for (const role of Object.keys(options.roles.roles)) {
			const row = group.byRole.get(role) ?? null;
			roles[role] = row ? { source: row.source } : null;
			keyRoles[role] = roleKeySource(options.roles.roles[role]!, row ? row.source : null);
			if (row) {
				roleTokens[role] = row.token;
				boundRoles.push(role);
			} else missingRoles.push(role);
		}
		const requiredMissing = missingRoles.filter((role) => options.roles.roles[role]?.required);
		// Multi-role endpoints carry the pipeline's components (never config);
		// one copy per group, shared by its endpoints.
		const safeComponents = multiRole ? components.map(safeComponent).filter((c): c is IExplorerComponent => c !== null) : [];
		// Frozen, so a filter cannot change what it is told about the next component.
		const groupInfo: INodeFilterGroup = Object.freeze({
			toolsSource: toolsRow ? toolsRow.source : null,
			toolsSources: Object.freeze(toolsSourcesOf(options.roles, components, toolsRow)),
			anchorRole,
			boundRoles: Object.freeze([...boundRoles]),
		});

		for (const component of components) {
			if (!component || typeof component.id !== 'string' || typeof component.provider !== 'string' || component.id === '') continue;
			if (!options.providers.has(component.provider)) continue;
			if (options.nodeFilter !== undefined && !options.nodeFilter(safeComponent(component)!, groupInfo)) continue;
			const key = buildEndpointKey({
				runKind: anchor.runKind,
				ownerKind,
				ownerId: anchor.ownerId,
				teamId: anchor.teamId,
				projectId,
				roles: keyRoles,
				nodeId: component.id,
			});
			const stopped = requiredMissing.length > 0;
			const endpoint: IExplorerEndpoint = {
				key,
				legacyKey: legacyKeyFromKey(key),
				projectId,
				pipelineName: displayNameOf(toolsRow, anchor, components, taskNames),
				runKind: anchor.runKind,
				ownerKind,
				ownerId: anchor.ownerId,
				teamId: anchor.teamId,
				roles,
				missingRoles,
				source: toolsRow ? toolsRow.source : '',
				nodeId: component.id,
				nodeName: typeof component.name === 'string' && component.name !== '' ? component.name : component.id,
				provider: component.provider,
				state: stopped ? 'stopped' : 'probing',
				running: !stopped,
			};
			if (multiRole) {
				endpoint.components = safeComponents;
				endpoint.anchorRole = anchorRole;
				endpoint.readOnly = readOnly;
			}
			if (stopped) endpoint.stateDetail = `Not running: ${requiredMissing.join(', ')} ${requiredMissing.length === 1 ? 'source is' : 'sources are'} not running for this pipeline.`;
			else if (readOnly) endpoint.stateDetail = READ_ONLY_DETAIL;
			// Two groups can only share a key when their rows carry no project id
			// (see IExplorerEndpoint.projectId): that is not provable to be one
			// project, so the groups stay unmerged and the STRONGER claim wins the
			// key (callable over read-only over stopped) — a stopped or read-only
			// duplicate must never hide a callable connection.
			const earlier = seen.get(key);
			if (earlier !== undefined) {
				if (claimRank(found[earlier]!.endpoint) >= claimRank(endpoint)) continue;
				found.splice(earlier, 1);
				seen.clear();
				found.forEach((entry, index) => seen.set(entry.endpoint.key, index));
			}
			seen.set(key, found.length);
			found.push({
				endpoint,
				token: anchorRow ? anchorRow.token : null,
				callHint: identityCanCallTools(options.identity ?? null, ownerKind, anchor.ownerId),
				roleTokens: { ...roleTokens },
				anchorRole,
			});
		}
	});

	found.sort((a, b) => a.endpoint.pipelineName.localeCompare(b.endpoint.pipelineName)
		|| a.endpoint.nodeId.localeCompare(b.endpoint.nodeId)
		|| a.endpoint.key.localeCompare(b.endpoint.key));
	return found;
}
