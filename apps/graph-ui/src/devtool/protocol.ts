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
// GRAPH-UI - DEV-TOOL PROTOCOL (what crosses between the controller and frames)
// =============================================================================
//
// As a dev tool, Graph Explorer is mounted twice: the SIDEBAR is the controller
// (it owns the endpoint store, tokens, identity, schema snapshots, data
// versions, history and every engine call) and each DOCUMENT FRAME holds no
// client. This file is the contract between them; it is plain data and types.
//
//   OPS (frame -> controller; every one answers a Reply and carries deadlineAt)
//     graph.refreshEndpoints  start discovery (results arrive as `endpoints`)
//     graph.probe             Test connection: one `dialect` call
//     graph.loadSchema        start a schema load (results arrive as `schemas`)
//     graph.readQuery         one `read_query`
//     graph.execute           one `execute` (shape 'graph'); the controller
//                             re-checks the write gate and counts the write
//     graph.ask               one `get_query`
//     graph.historyList       one connection's history (bulk: an op result)
//     graph.historyEdit       every history mutation, recording a run included
//     graph.writeAbandoned    a write the user stopped waiting for
//
//   STATE (controller -> frames; retained, each snapshot under 64 KiB)
//     endpoints     the endpoint store's snapshot (capped; see below)
//     schemas       per connection: status and label names only (capped)
//     dataVersions  per connection: has a write run there?
//     history       { rev }: a frame re-reads its list when it changes
//     identity      { fingerprint } (frameIdentity.ts)
//     previews      the pending sidebar preview request (graph/previews.ts)
//
//   EVENTS (frame -> controller; idempotent hints only)
//     active        { docKey, consumed? }: which document is fronted (the
//                   fallback while the host's activeDocKey is undefined) and
//                   the preview nonce this frame took
//
// Every op names an endpoint by its library KEY (owner-aware, token-free),
// never by an endpoint object, and never carries a token. Bulk data (rows,
// history lists) travels as op RESULTS, never as retained state.
// =============================================================================

import type { ToolOpMap, ToolOpSpec } from 'shell';
import { DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_PAD_MS, DEFAULT_TOOL_TIMEOUTS } from 'shared/explorer';
import type { IEndpointState, IHistoryEntry, IProbeResult } from 'shared/explorer';
import type { IDeadline } from 'shared/explorer/devtool/deadline';
import type { IIdentityState } from 'shared/explorer/devtool/frameIdentity';
import type { Reply } from 'shared/explorer/devtool/reply';
import { jsonByteLength, MAX_RETAINED_STATE_BYTES } from 'shared/explorer/devtool/state';
import { frameOpTimeoutMs, toolCallBudgetMs } from 'shared/explorer/devtool/timeouts';
import { isWorkbenchUri, isWriteUri, workbenchUri, writeUri } from '../graph/addresses';
import type { IGraphPreview } from '../graph/previews';
import type { ISchemaEntry } from '../graph/schemaStore';
import type { ReadQueryResult } from '../graph/types';

/** The tool's app id (also the manifest id). */
export const GRAPH_APP_ID = 'rocketride.graph';

// =============================================================================
// OPS
// =============================================================================

/** Op wire names. */
export const OP = {
	refreshEndpoints: 'graph.refreshEndpoints',
	probe: 'graph.probe',
	loadSchema: 'graph.loadSchema',
	readQuery: 'graph.readQuery',
	execute: 'graph.execute',
	ask: 'graph.ask',
	historyList: 'graph.historyList',
	historyEdit: 'graph.historyEdit',
	writeAbandoned: 'graph.writeAbandoned',
} as const;

/** One connection's history as a frame shows it. */
export interface IGraphHistoryView {
	/** Newest first. */
	entries: IHistoryEntry<'cypher'>[];
	/** Whether runs on the connection are recorded. */
	recording: boolean;
}

/** A history mutation (recording a finished run is one too). */
export type HistoryEdit =
	| { action: 'record'; entry: IHistoryEntry<'cypher'> }
	| { action: 'remove'; id: string }
	| { action: 'pin'; id: string }
	| { action: 'note'; id: string; note: string }
	| { action: 'clear' }
	| { action: 'recording'; on: boolean };

/** The ops a frame calls. */
export interface GraphOps extends ToolOpMap {
	'graph.refreshEndpoints': ToolOpSpec<IDeadline & { reprobe?: boolean }, Reply<null>>;
	'graph.probe': ToolOpSpec<IDeadline & { key: string }, Reply<IProbeResult | null>>;
	'graph.loadSchema': ToolOpSpec<IDeadline & { key: string; fresh?: boolean }, Reply<null>>;
	'graph.readQuery': ToolOpSpec<IDeadline & { key: string; cypher: string; params: Record<string, unknown>; limit: number }, Reply<ReadQueryResult>>;
	'graph.execute': ToolOpSpec<IDeadline & { key: string; query: string }, Reply<ReadQueryResult>>;
	'graph.ask': ToolOpSpec<IDeadline & { key: string; question: string }, Reply<unknown>>;
	'graph.historyList': ToolOpSpec<IDeadline & { key: string }, Reply<IGraphHistoryView>>;
	'graph.historyEdit': ToolOpSpec<IDeadline & { key: string; edit: HistoryEdit }, Reply<null>>;
	'graph.writeAbandoned': ToolOpSpec<IDeadline & { key: string }, Reply<null>>;
}

// =============================================================================
// STATE AND EVENTS
// =============================================================================

/** State topic names. */
export const STATE = {
	endpoints: 'endpoints',
	schemas: 'schemas',
	dataVersions: 'dataVersions',
	history: 'history',
	identity: 'identity',
	previews: 'previews',
} as const;

/** The endpoint store's snapshot as it crosses: `omitted` endpoints did not fit the cap. */
export interface IGraphEndpointsState extends IEndpointState {
	/** How many endpoints were left out to keep the snapshot under its cap (0 normally). */
	omitted: number;
}

/**
 * What a frame needs of one connection's schema: the label names (graph colours) and how far it got. A load that
 * failed or timed out at the controller arrives as `status: 'error'` with the reason, never as an endless 'loading'.
 */
export interface IFrameSchema {
	status: ISchemaEntry['status'];
	labels: string[];
	loadedAt: number;
	/** Why the latest load failed (its headline), or null. */
	failure: string | null;
}

/** The retained state, by topic. */
export interface GraphStateMap {
	endpoints: IGraphEndpointsState;
	schemas: Record<string, IFrameSchema>;
	dataVersions: Record<string, number>;
	history: { rev: number };
	identity: IIdentityState;
	previews: { pending: IGraphPreview | null };
}

/** Event names (disjoint from every op name: the op server would run an event named like an op). */
export const EVENT = { active: 'active' } as const;

/** The `active` event: the fronted document, and the preview nonce this frame took. */
export interface IActiveEvent {
	docKey: string;
	consumed?: string;
}

/** The events, by name. */
export interface GraphEventMap {
	active: IActiveEvent;
}

/** The empty endpoint snapshot (before the controller published one). */
export const NO_ENDPOINTS: IGraphEndpointsState = { status: 'idle', endpoints: [], probes: {}, error: null, refreshedAt: 0, omitted: 0 };

// =============================================================================
// TIMEOUTS (R5): the frame always waits longer than the controller can take
// =============================================================================

/** What the controller answers from memory (a refresh or schema load it starts, history, marks). */
export const CONTROLLER_LOCAL_OP_MS = 10_000;

/**
 * The session wait of a statement on a node (read_query and execute): its published statement deadline plus the
 * session's pad, else the session default (connect/session.ts budgetFor).
 *
 * @param info - The node's `dialect` answer, or null.
 * @returns Milliseconds.
 */
export function statementWaitMs(info: Record<string, unknown> | null): number {
	const limits = info !== null && info.limits !== null && typeof info.limits === 'object' ? (info.limits as Record<string, unknown>) : null;
	const deadline = limits?.statement_timeout_ms;
	return typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0 ? deadline + DEFAULT_TIMEOUT_PAD_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * The frame's timeout for an op: the controller's own bound for it (one tool call through the bus adapter, or an
 * answer from memory) plus the frame margin.
 *
 * @param op - The op.
 * @param info - The node's `dialect` answer (statements derive their wait from it).
 * @returns The `timeoutMs` the frame passes.
 */
export function frameTimeoutFor(op: keyof GraphOps & string, info: Record<string, unknown> | null = null): number {
	switch (op) {
		case OP.probe:
			return frameOpTimeoutMs(toolCallBudgetMs(DEFAULT_TOOL_TIMEOUTS.dialect));
		case OP.readQuery:
		case OP.execute:
			return frameOpTimeoutMs(toolCallBudgetMs(statementWaitMs(info)));
		case OP.ask:
			return frameOpTimeoutMs(toolCallBudgetMs(DEFAULT_TOOL_TIMEOUTS.get_query));
		default:
			// refreshEndpoints and loadSchema START work whose results arrive as state; the rest are answered from memory.
			return frameOpTimeoutMs(CONTROLLER_LOCAL_OP_MS);
	}
}

// =============================================================================
// DOCUMENTS (R8): the docKey families are the app's own URIs
// =============================================================================

/** Where a frame's docKey routes. */
export type DocRoute = { kind: 'landing' } | { kind: 'workbench' | 'write'; key: string } | { kind: 'unknown'; docKey: string };

/**
 * Route a frame's docKey: undefined (VS Code's generic frame) and '' (rocket-ui's) are the landing,
 * `workbench:<key>` and `write:<key>` are a connection's documents, anything else is not found.
 *
 * @param docKey - The frame's docKey.
 * @returns The route.
 */
export function routeDocKey(docKey: string | null | undefined): DocRoute {
	if (docKey === undefined || docKey === null || docKey === '') return { kind: 'landing' };
	if (isWorkbenchUri(docKey) && docKey.length > 'workbench:'.length) return { kind: 'workbench', key: docKey.slice('workbench:'.length) };
	if (isWriteUri(docKey) && docKey.length > 'write:'.length) return { kind: 'write', key: docKey.slice('write:'.length) };
	return { kind: 'unknown', docKey };
}

/**
 * The docKey of a connection's document.
 *
 * @param kind - Workbench or write console.
 * @param key - The endpoint key.
 * @returns The docKey (the app's own URI).
 */
export function docKeyFor(kind: 'workbench' | 'write', key: string): string {
	return kind === 'workbench' ? workbenchUri(key) : writeUri(key);
}

// =============================================================================
// SNAPSHOTS: retained state stays small (T11)
// =============================================================================

/** Budget of the endpoints snapshot (under the retained-state cap, leaving room for the envelope). */
export const ENDPOINTS_STATE_BYTES = MAX_RETAINED_STATE_BYTES - 4 * 1024;

/** Budget of the schemas snapshot. */
export const SCHEMAS_STATE_BYTES = 48 * 1024;

/**
 * Budget of the data-versions snapshot. With the endpoints and schemas budgets this leaves about 3 KiB of the base's
 * 128 KiB total (MAX_RETAINED_TOTAL_BYTES) for identity, history, previews and the readiness topic, so the fixed
 * topics always fit together and the guard never has to degrade or withhold one of them.
 */
export const VERSIONS_STATE_BYTES = 16 * 1024;

/**
 * Read a plain object's field.
 *
 * @param value - Anything.
 * @param name - The field.
 * @returns Its value, or undefined.
 */
export function field(value: unknown, name: string): unknown {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
}

/**
 * The data-versions snapshot, cut to the budget: the connections a frame can show (those in the published endpoints
 * snapshot) first, then the most recently written. A connection left out reads as version 0 in the frames, which a
 * drawn graph that already saw a write treats as "may have changed" (the conservative reading).
 *
 * @param all - Every version, ordered from the least to the most recently bumped (IDataVersions.snapshot).
 * @param shown - The keys in the published endpoints snapshot.
 * @param maxBytes - The budget.
 * @returns The snapshot.
 */
export function versionsSnapshot(all: Record<string, number>, shown: ReadonlySet<string>, maxBytes: number = VERSIONS_STATE_BYTES): Record<string, number> {
	if (jsonByteLength(all) <= maxBytes) return { ...all };
	const newestFirst = Object.keys(all).reverse();
	const ordered = [...newestFirst.filter((key) => shown.has(key)), ...newestFirst.filter((key) => !shown.has(key))];
	const out: Record<string, number> = {};
	let bytes = 2;
	for (const key of ordered) {
		const size = jsonByteLength({ [key]: all[key] });
		if (bytes + size > maxBytes) continue;
		out[key] = all[key];
		bytes += size;
	}
	return out;
}

/**
 * A value as JSON carries it (undefined members dropped). Every snapshot and small op result is normalised so both
 * hosts deliver the same thing: VS Code's postMessage would drop the same members anyway.
 *
 * @param value - A plain value.
 * @returns Its JSON image.
 */
export function toWire<T>(value: T): T {
	const text = JSON.stringify(value);
	return (text === undefined ? null : JSON.parse(text)) as T;
}

/**
 * The endpoints snapshot: the store's state as JSON, cut to the budget. Endpoints are dropped from the end of the
 * (sorted) list, with their probes, and counted in `omitted`, so the landing can say that some are not shown.
 *
 * @param state - The endpoint store's snapshot.
 * @param maxBytes - The budget.
 * @returns The snapshot.
 */
export function endpointsSnapshot(state: IEndpointState, maxBytes: number = ENDPOINTS_STATE_BYTES): IGraphEndpointsState {
	const full: IGraphEndpointsState = toWire({ status: state.status, endpoints: state.endpoints, probes: state.probes, error: state.error, refreshedAt: state.refreshedAt, omitted: 0 });
	if (jsonByteLength(full) <= maxBytes) return full;
	const cut = (kept: number): IGraphEndpointsState => {
		const endpoints = full.endpoints.slice(0, kept);
		const probes: Record<string, IProbeResult> = {};
		for (const endpoint of endpoints) if (full.probes[endpoint.key]) probes[endpoint.key] = full.probes[endpoint.key];
		return { ...full, endpoints, probes, omitted: full.endpoints.length - kept };
	};
	// The longest prefix that fits, by binary search: this runs on every store change (each probe), so it must not
	// serialise the list once per endpoint dropped. Only a prefix that was measured to fit is ever returned.
	let fits = 0;
	let tooBig = full.endpoints.length;
	while (tooBig - fits > 1) {
		const mid = Math.floor((fits + tooBig) / 2);
		if (jsonByteLength(cut(mid)) <= maxBytes) fits = mid;
		else tooBig = mid;
	}
	return cut(fits);
}

/**
 * The schemas snapshot: per connection, its status and label names, newest load first, cut to the budget (a
 * connection left out simply has no labels in its frames until it is loaded again).
 *
 * @param entries - Every connection's schema entry.
 * @param maxBytes - The budget.
 * @returns The snapshot.
 */
export function schemasSnapshot(entries: ReadonlyArray<readonly [string, ISchemaEntry]>, maxBytes: number = SCHEMAS_STATE_BYTES): Record<string, IFrameSchema> {
	const ordered = [...entries].sort((a, b) => b[1].loadedAt - a[1].loadedAt);
	const out: Record<string, IFrameSchema> = {};
	let bytes = 2;
	for (const [key, entry] of ordered) {
		const item: IFrameSchema = { status: entry.status, labels: entry.view.labels.map((label) => label.name), loadedAt: entry.loadedAt, failure: entry.failure ? entry.failure.headline : null };
		const size = jsonByteLength({ [key]: item });
		if (bytes + size > maxBytes) continue;
		out[key] = item;
		bytes += size;
	}
	return out;
}
