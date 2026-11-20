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
// VECTOR-UI - DEV-TOOL PROTOCOL (what crosses between the controller and frames)
// =============================================================================
//
// As a dev tool, Vector Explorer is mounted twice: the SIDEBAR is the
// controller (it owns the endpoint store, tokens, identity and every engine
// call) and each DOCUMENT FRAME holds no client. This file is the contract
// between them; it is plain data, types and pure helpers.
//
//   OPS (frame -> controller; every one answers a Reply and carries deadlineAt)
//     vector.refresh           start discovery (results arrive as `endpoints`)
//     vector.probe             Test connection: one `dialect` call
//     vector.stats .. vector.similarityMatrix
//                              one read tool each, `{ key, input }`, where
//                              `input` is the tool's own input; the raw answer
//                              comes back as the value, a failure ENVELOPE
//                              included (the frame unwraps it with its code)
//     vector.trash / restore / deletePermanently
//                              one write batch each, `{ key, input, origin }`;
//                              the controller re-checks the write gate, sends
//                              once (never retried) and bumps `docVersions`
//     vector.requestFocus      a document frame should show a chunk
//     vector.showOnMap         a console should show keys on its map
//
//   STATE (controller -> frames; retained, fixed topics of maps by key)
//     endpoints        the endpoint store's snapshot (capped; see below)
//     identity         { fingerprint } (frameIdentity.ts)
//     docVersions      per connection: the last write that ran (any frame's);
//                      over its budget every stamp stays and only the newest
//                      writes keep `gone` (versionsSnapshot)
//     queries          per connection: the console's query text (a nonce each)
//     consoleSummary   per connection: the console's median chunk count
//     focusRequests    per connection: a pending chunk focus (a nonce)
//     mapRequests      per connection: pending keys for the map (a nonce)
//
//   EVENTS (idempotent hints only; names disjoint from every op)
//     frame -> controller   active, queryChanged, consoleSummary
//     controller -> frames  focusChunk, showOnMap (each carries its docKey;
//                           frames filter on it and take a nonce once)
//
// THE WAITS. A frame's remote channel (devtool/frame.ts remoteChannel) takes
// each op's timeout from frameTimeoutFor, never from the caller's own
// `opts.timeoutMs`: the controller waits what waitFor names for the same op
// and the same probe, so the frame's wait is always the controller's plus the
// bus and frame margins (R5). The views' own waits (MapView's sample budget +
// 30 s, the panels' 60 s for search and embed) are the same numbers today.
// A call that waited at the controller for discovery runs only inside what is
// left of its deadline, and is not started when less than a second is left.
//
// Every op names an endpoint by its library KEY (owner-aware, token-free),
// never by an endpoint object, and never carries a token or a node id: the
// controller resolves the store node and the embedding node itself
// (vector/consoleModel.ts consoleNodes). Bulk data (samples, listings,
// chunks) travels as op RESULTS, never as retained state.
// =============================================================================

import type { ToolOpMap, ToolOpSpec } from 'shell';
import { DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_PAD_MS, DEFAULT_TOOL_TIMEOUTS } from 'shared/explorer';
import type { IEndpointState, IProbeResult } from 'shared/explorer';
import type { IDeadline } from 'shared/explorer/devtool/deadline';
import type { IIdentityState } from 'shared/explorer/devtool/frameIdentity';
import type { Reply } from 'shared/explorer/devtool/reply';
import { jsonByteLength, MAX_RETAINED_STATE_BYTES } from 'shared/explorer/devtool/state';
import { frameOpTimeoutMs, toolCallBudgetMs } from 'shared/explorer/devtool/timeouts';
import type { HighlightSource, VectorKey } from '../contract/types';
import type { IVectorEndpointsState } from '../env';
import { consoleUri, isConsoleUri, isDocumentUri } from '../vector/addresses';
import { DEFAULT_LIMITS, readDialect } from '../vector/results';

/** The tool's app id (also the manifest id). */
export const VECTOR_APP_ID = 'rocketride.vector';

// =============================================================================
// OPS
// =============================================================================

/** Op wire names. */
export const OP = {
	refresh: 'vector.refresh',
	probe: 'vector.probe',
	stats: 'vector.stats',
	list: 'vector.list',
	chunks: 'vector.chunks',
	sample: 'vector.sample',
	project: 'vector.project',
	neighbors: 'vector.neighbors',
	search: 'vector.search',
	embed: 'vector.embed',
	recommend: 'vector.recommend',
	similarityMatrix: 'vector.similarityMatrix',
	trash: 'vector.trash',
	restore: 'vector.restore',
	deletePermanently: 'vector.deletePermanently',
	requestFocus: 'vector.requestFocus',
	showOnMap: 'vector.showOnMap',
} as const;

/** The ops that read through one tool. */
export type ReadOp = typeof OP.stats | typeof OP.list | typeof OP.chunks | typeof OP.sample | typeof OP.project | typeof OP.neighbors | typeof OP.search | typeof OP.embed | typeof OP.recommend | typeof OP.similarityMatrix;

/** The ops that write one batch through one tool. */
export type WriteOp = typeof OP.trash | typeof OP.restore | typeof OP.deletePermanently;

/** Every op that calls one tool. */
export type ToolOp = ReadOp | WriteOp;

/** The tool each tool op calls. */
export const OP_TOOL: Readonly<Record<ToolOp, string>> = {
	[OP.stats]: 'stats',
	[OP.list]: 'list_documents',
	[OP.chunks]: 'chunks',
	[OP.sample]: 'sample',
	[OP.project]: 'project',
	[OP.neighbors]: 'neighbors',
	[OP.search]: 'search',
	[OP.embed]: 'embed',
	[OP.recommend]: 'recommend',
	[OP.similarityMatrix]: 'similarity_matrix',
	[OP.trash]: 'soft_delete',
	[OP.restore]: 'restore',
	[OP.deletePermanently]: 'delete',
};

/** The op that carries each tool a frame may call (the frame's remote caller maps a tool to its op). */
export const TOOL_OP: Readonly<Record<string, ToolOp>> = Object.fromEntries(Object.entries(OP_TOOL).map(([op, tool]) => [tool, op as ToolOp]));

/** The write ops. */
export const WRITE_OPS: ReadonlySet<string> = new Set<string>([OP.trash, OP.restore, OP.deletePermanently]);

/** One read: the connection and the tool's own input. */
export interface IToolParams extends IDeadline {
	key: string;
	input: Record<string, unknown>;
}

/** One write batch: the connection, the tool's input, and the calling frame (so it skips its own version bump). */
export interface IWriteParams extends IToolParams {
	origin: string;
}

/** The ops a frame calls. */
export interface VectorOps extends ToolOpMap {
	'vector.refresh': ToolOpSpec<IDeadline & { reprobe?: boolean }, Reply<null>>;
	'vector.probe': ToolOpSpec<IDeadline & { key: string }, Reply<IProbeResult | null>>;
	'vector.stats': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.list': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.chunks': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.sample': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.project': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.neighbors': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.search': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.embed': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.recommend': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.similarityMatrix': ToolOpSpec<IToolParams, Reply<unknown>>;
	'vector.trash': ToolOpSpec<IWriteParams, Reply<unknown>>;
	'vector.restore': ToolOpSpec<IWriteParams, Reply<unknown>>;
	'vector.deletePermanently': ToolOpSpec<IWriteParams, Reply<unknown>>;
	'vector.requestFocus': ToolOpSpec<IDeadline & { key: string; docKey: string; chunkId: number }, Reply<null>>;
	'vector.showOnMap': ToolOpSpec<IDeadline & { key: string; keys: VectorKey[]; source: HighlightSource }, Reply<null>>;
}

// =============================================================================
// STATE AND EVENTS
// =============================================================================

/** State topic names. */
export const STATE = {
	endpoints: 'endpoints',
	identity: 'identity',
	docVersions: 'docVersions',
	queries: 'queries',
	consoleSummary: 'consoleSummary',
	focusRequests: 'focusRequests',
	mapRequests: 'mapRequests',
} as const;

/** The writes a version bump names. */
export type DocWriteAction = 'trash' | 'restore' | 'delete' | 'empty';

/**
 * The last write that ran on a connection. Frames treat a CHANGE of `version` as "refetch", never "greater than": a
 * remounted controller starts its counters again.
 */
export interface IDocVersion {
	version: number;
	/** The controller mount that counted it (a remounted controller counts again from 1; see the frames' bindings). */
	epoch: string;
	action: DocWriteAction;
	/**
	 * The documents that left the stored ones (moved to the trash, or deleted); empty for a restore or an unknown
	 * outcome, and for an older write when the snapshot is over its budget (versionsSnapshot).
	 */
	gone: string[];
	/** The frame that asked for it (it refreshed itself already). */
	origin: string;
}

/** A console's query (its text only: the document frames embed it themselves). */
export interface IQueryHint {
	nonce: string;
	text: string | null;
}

/** What a document frame compares a document with. */
export interface IConsoleSummary {
	medianChunks: number | null;
}

/** A pending chunk focus for one document frame. */
export interface IFocusRequest {
	nonce: string;
	docKey: string;
	chunkId: number;
}

/** Pending keys for a connection's map. */
export interface IMapRequest {
	nonce: string;
	keys: VectorKey[];
	source: HighlightSource;
}

/** The retained state, by topic. */
export interface VectorStateMap {
	endpoints: IVectorEndpointsState;
	identity: IIdentityState;
	docVersions: Record<string, IDocVersion>;
	queries: Record<string, IQueryHint>;
	consoleSummary: Record<string, IConsoleSummary>;
	focusRequests: Record<string, IFocusRequest>;
	mapRequests: Record<string, IMapRequest>;
}

/** Event names (disjoint from every op name: the op server would run an event named like an op). */
export const EVENT = {
	active: 'active',
	queryChanged: 'queryChanged',
	consoleSummary: 'consoleSummary',
	focusChunk: 'focusChunk',
	showOnMap: 'showOnMap',
} as const;

/** The `active` event: the fronted document, and the request nonces this frame took. */
export interface IActiveEvent {
	docKey: string;
	consumed?: string[];
}

/** The events, by name. */
export interface VectorEventMap {
	active: IActiveEvent;
	queryChanged: { key: string; nonce: string; text: string | null };
	consoleSummary: { key: string; medianChunks: number | null };
	focusChunk: { docKey: string; chunkId: number; nonce: string };
	showOnMap: { docKey: string; keys: VectorKey[]; source: HighlightSource; nonce: string };
}

/** The empty endpoint snapshot (before the controller published one). */
export const NO_ENDPOINTS: IVectorEndpointsState = { status: 'idle', endpoints: [], probes: {}, error: null, refreshedAt: 0, omitted: 0 };

/** The highlight sources a map request may name. */
export const HIGHLIGHT_SOURCES: ReadonlySet<string> = new Set<HighlightSource>(['chat', 'search', 'neighbors', 'lasso', 'document']);

/** The longest query text the controller keeps (the chat's own cap). */
export const QUERY_TEXT_MAX = 4_000;

/** How long a focus or map request nobody took stays pending. */
export const FOCUS_MAX_AGE_MS = 60_000;

// =============================================================================
// TIMEOUTS (R5): the frame always waits longer than the controller can take
// =============================================================================

/** What the controller answers from memory or starts (refresh). */
export const CONTROLLER_LOCAL_OP_MS = 10_000;

/** A relay (requestFocus, showOnMap): a publish and an event. */
export const RELAY_OP_MS = 5_000;

/** The highest sample budget the waits follow (a node publishing more is waited for this long). */
export const SAMPLE_BUDGET_CAP_MS = 300_000;

/** The pad on a sample's own budget (MapView's wait: budget + 30 s). */
export const SAMPLE_PAD_MS = 30_000;

/** The wait of a search and of an embedding (the full app's panels wait 60 s for both). */
export const PANEL_WAIT_MS = 60_000;

/**
 * Read the node's raw limits.
 *
 * @param info - The node's `dialect` answer, or null.
 * @returns The limits object, or null.
 */
function rawLimits(info: Record<string, unknown> | null): Record<string, unknown> | null {
	return info !== null && info.limits !== null && typeof info.limits === 'object' ? (info.limits as Record<string, unknown>) : null;
}

/**
 * The session wait of one tool op: a sample its node budget (capped) plus 30 s, a search or an embedding 60 s, every
 * other read and write the node's published statement deadline plus the session's pad (else the session default).
 * The controller asks the session for exactly this, so the bus and the frame derive theirs from it.
 *
 * @param op - The op.
 * @param info - The node's `dialect` answer (the controller's probe; the frame's copy of it), or null.
 * @returns Milliseconds.
 */
export function waitFor(op: string, info: Record<string, unknown> | null): number {
	switch (op) {
		case OP.probe:
			return DEFAULT_TOOL_TIMEOUTS.dialect;
		case OP.sample: {
			const budget = (readDialect(info)?.limits ?? DEFAULT_LIMITS).sample_budget_ms;
			const usable = typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_LIMITS.sample_budget_ms;
			return Math.min(usable, SAMPLE_BUDGET_CAP_MS) + SAMPLE_PAD_MS;
		}
		case OP.search:
		case OP.embed:
			return PANEL_WAIT_MS;
		default: {
			const deadline = rawLimits(info)?.statement_timeout_ms;
			return typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0 ? deadline + DEFAULT_TIMEOUT_PAD_MS : DEFAULT_TIMEOUT_MS;
		}
	}
}

/**
 * The frame's timeout for an op: the controller's own bound for it (one tool call through the bus adapter, or an
 * answer from memory) plus the frame margin.
 *
 * @param op - The op.
 * @param info - The node's `dialect` answer, as the endpoints state carries it.
 * @returns The `timeoutMs` the frame passes.
 */
export function frameTimeoutFor(op: keyof VectorOps & string, info: Record<string, unknown> | null = null): number {
	switch (op) {
		case OP.refresh:
			return frameOpTimeoutMs(CONTROLLER_LOCAL_OP_MS);
		case OP.requestFocus:
		case OP.showOnMap:
			return frameOpTimeoutMs(RELAY_OP_MS);
		default:
			return frameOpTimeoutMs(toolCallBudgetMs(waitFor(op, info)));
	}
}

// =============================================================================
// SIZES (T11): results are capped, retained snapshots are budgeted
// =============================================================================

/** The largest result each op sends to a frame (an app-defined RESULT_TOO_LARGE above it). */
export const RESULT_CAPS: Readonly<Record<ToolOp, number>> = {
	[OP.sample]: 1.5 * 1024 * 1024,
	[OP.list]: 512 * 1024,
	[OP.chunks]: 768 * 1024,
	[OP.search]: 512 * 1024,
	[OP.embed]: 512 * 1024,
	[OP.recommend]: 256 * 1024,
	[OP.similarityMatrix]: 128 * 1024,
	[OP.project]: 128 * 1024,
	[OP.neighbors]: 128 * 1024,
	[OP.stats]: 64 * 1024,
	[OP.trash]: 64 * 1024,
	[OP.restore]: 64 * 1024,
	[OP.deletePermanently]: 64 * 1024,
};

/** The app-defined code of a result too large to send (no engine code collides with it). */
export const RESULT_TOO_LARGE = 'RESULT_TOO_LARGE';

/** Budget of the endpoints snapshot. */
export const ENDPOINTS_STATE_BYTES = 56 * 1024;

/** Budget of the docVersions snapshot. */
export const VERSIONS_STATE_BYTES = 16 * 1024;

/** Budget of the queries snapshot. */
export const QUERIES_STATE_BYTES = 16 * 1024;

/** Budget of the consoleSummary snapshot. */
export const SUMMARY_STATE_BYTES = 4 * 1024;

/** Budget of the focusRequests snapshot. */
export const FOCUS_STATE_BYTES = 4 * 1024;

/**
 * Budget of the mapRequests snapshot. With the others this leaves about 16 KiB of the base's 128 KiB total for the
 * identity and readiness topics, so the fixed topics always fit together.
 */
export const MAP_STATE_BYTES = 16 * 1024;

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
 * A value as JSON carries it (undefined members dropped), so both hosts deliver the same thing.
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
 * (sorted) list, with their probes, and counted in `omitted`, so a document can say that some are not listed.
 *
 * @param state - The endpoint store's snapshot.
 * @param maxBytes - The budget.
 * @returns The snapshot.
 */
export function endpointsSnapshot(state: IEndpointState, maxBytes: number = ENDPOINTS_STATE_BYTES): IVectorEndpointsState {
	const full: IVectorEndpointsState = toWire({ status: state.status, endpoints: state.endpoints, probes: state.probes, error: state.error, refreshedAt: state.refreshedAt, omitted: 0 });
	if (jsonByteLength(full) <= maxBytes) return full;
	const cut = (kept: number): IVectorEndpointsState => {
		const endpoints = full.endpoints.slice(0, kept);
		const probes: Record<string, IProbeResult> = {};
		for (const endpoint of endpoints) if (full.probes[endpoint.key]) probes[endpoint.key] = full.probes[endpoint.key];
		return { ...full, endpoints, probes, omitted: full.endpoints.length - kept };
	};
	// The longest prefix that fits, by binary search (this runs on every store change).
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
 * A keyed map cut to a budget: the keys a frame can show (those in the published endpoints snapshot) first, then the
 * most recently changed. A connection left out reads as "nothing pending" in the frames.
 *
 * @param all - Every entry, ordered from the least to the most recently changed.
 * @param shown - The keys in the published endpoints snapshot.
 * @param maxBytes - The budget.
 * @returns The snapshot.
 */
export function keyedSnapshot<T>(all: ReadonlyMap<string, T>, shown: ReadonlySet<string>, maxBytes: number): Record<string, T> {
	const whole = toWire(Object.fromEntries(all));
	if (jsonByteLength(whole) <= Math.min(maxBytes, MAX_RETAINED_STATE_BYTES)) return whole;
	const newestFirst = [...all.keys()].reverse();
	const ordered = [...newestFirst.filter((key) => shown.has(key)), ...newestFirst.filter((key) => !shown.has(key))];
	const out: Record<string, T> = {};
	let bytes = 2;
	for (const key of ordered) {
		const size = jsonByteLength({ [key]: all.get(key) });
		if (bytes + size > maxBytes) continue;
		out[key] = toWire(all.get(key) as T);
		bytes += size;
	}
	return out;
}

/**
 * The docVersions snapshot cut to a budget. Frames refetch on a change of a connection's stamp (epoch, version) and
 * read `gone` only to drop a selection that left, so the stamps go first: a stamp that left the snapshot and came back
 * would read as a new write. Every stamp that fits is kept (keyedSnapshot's order, with no `gone`), then `gone` is put
 * back on entries in the same order while the budget allows, so the newest writes keep what they moved.
 *
 * @param all - Every connection's last write, ordered from the least to the most recently changed.
 * @param shown - The keys in the published endpoints snapshot.
 * @param maxBytes - The budget.
 * @returns The snapshot.
 */
export function versionsSnapshot(all: ReadonlyMap<string, IDocVersion>, shown: ReadonlySet<string>, maxBytes: number): Record<string, IDocVersion> {
	const budget = Math.min(maxBytes, MAX_RETAINED_STATE_BYTES);
	const whole = toWire(Object.fromEntries(all));
	if (jsonByteLength(whole) <= budget) return whole;
	const stamps = new Map<string, IDocVersion>();
	for (const [key, version] of all) stamps.set(key, { ...version, gone: [] });
	const out = keyedSnapshot(stamps, shown, budget);
	let bytes = jsonByteLength(out);
	const newestFirst = [...all.keys()].reverse();
	for (const key of [...newestFirst.filter((k) => shown.has(k)), ...newestFirst.filter((k) => !shown.has(k))]) {
		const version = all.get(key) as IDocVersion;
		if (!Object.prototype.hasOwnProperty.call(out, key) || version.gone.length === 0) continue;
		// The entry already holds `[]`: putting the list back adds its JSON less those two bytes.
		const extra = jsonByteLength(version.gone) - 2;
		if (bytes + extra > budget) continue;
		out[key] = toWire(version);
		bytes += extra;
	}
	return out;
}

// =============================================================================
// DOCUMENTS (R8): the docKey families are the app's own URIs
// =============================================================================

/** Where a frame's docKey routes. */
export type DocRoute = { kind: 'landing' } | { kind: 'console'; key: string } | { kind: 'document'; key: string; objectId: string } | { kind: 'unknown'; docKey: string };

/**
 * Route a frame's docKey: undefined (VS Code's generic frame) and '' (rocket-ui's) are the landing,
 * `console:<key>` a connection's console, `document:<key>:<encoded objectId>` one stored document, anything else
 * (malformed ones included) is not found.
 *
 * @param docKey - The frame's docKey.
 * @returns The route.
 */
export function routeDocKey(docKey: string | null | undefined): DocRoute {
	if (docKey === undefined || docKey === null || docKey === '') return { kind: 'landing' };
	if (isConsoleUri(docKey)) {
		const key = docKey.slice('console:'.length);
		return key !== '' && !key.includes(':') ? { kind: 'console', key } : { kind: 'unknown', docKey };
	}
	if (isDocumentUri(docKey)) {
		const rest = docKey.slice('document:'.length);
		const at = rest.lastIndexOf(':');
		if (at <= 0 || at === rest.length - 1) return { kind: 'unknown', docKey };
		const key = rest.slice(0, at);
		let objectId: string;
		try {
			objectId = decodeURIComponent(rest.slice(at + 1));
		} catch {
			return { kind: 'unknown', docKey };
		}
		return key.includes(':') || objectId === '' ? { kind: 'unknown', docKey } : { kind: 'document', key, objectId };
	}
	return { kind: 'unknown', docKey };
}

/**
 * The docKey of a connection's console (the map is a tab inside it: no map docKey).
 *
 * @param key - The endpoint key.
 * @returns The docKey.
 */
export function consoleDocKey(key: string): string {
	return consoleUri(key);
}
