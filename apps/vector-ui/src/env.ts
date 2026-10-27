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
// VECTOR ENV - the one seam every view reaches the engine through (pure types)
// =============================================================================
//
// Views never call useShellConnection or the adapter's store singleton: they
// call useVectorEnv() (envContext.tsx) and the hooks there. Two
// implementations sit behind the one context:
//
//   LOCAL  (localEnv.ts)        over a realm's own endpoint store and client:
//                               the full app (`app:`, its SDK client) and the
//                               dev-tool CONTROLLER (the sidebar mount, its
//                               bus-backed client).
//   REMOTE (devtool/frame.ts)   over controller ops and retained state: every
//                               dev-tool document FRAME, which holds no client.
//
// This module is types and pure helpers only (no shell value, no React), so
// the pure adapters and a frame can import it.
// =============================================================================

import type { IEndpointState, IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import type { IVectorCaller } from './adapters/actions';
import type { IConnectionEntry } from './adapters/connections';
import type { ConsoleModel, IVectorLimits, VectorChannels } from './contract/types';

/** A value that changes, readable outside React (useSyncExternalStore-friendly: `get` is stable between changes). */
export interface IReadable<T> {
	get(): T;
	subscribe(listener: () => void): () => void;
}

/** A keyed value that changes (`get(key)` is stable between changes). */
export interface IKeyed<T> {
	get(key: string): T;
	subscribe(listener: () => void): () => void;
}

/** The endpoint store's snapshot as a mount sees it: `omitted` endpoints did not fit a frame's capped list (0 locally). */
export interface IVectorEndpointsState extends IEndpointState {
	omitted: number;
}

/** Which implementation an env is. */
export type VectorEnvKind = 'local' | 'remote';

/** What a dev-tool mount cannot serve, and why (the inline notes). */
export interface IDegraded {
	/** Why the chat cannot ask questions here. */
	chat: string;
	/** Why documents cannot be uploaded here. */
	uploads: string;
}

/** The engine surface a Vector Explorer view may use. */
export interface IVectorEnv {
	/** LOCAL (the full app, the controller) or REMOTE (a dev-tool frame). */
	kind: VectorEnvKind;
	/** Whether the engine is reachable (a frame: the host's `host:connection`). Drives what may be sent. */
	ready: boolean;
	/** Discovered connections and their probes. */
	endpoints: IReadable<IVectorEndpointsState>;
	/**
	 * Discover (and probe) now; failures show in `endpoints`. `quiet`: an automatic refresh (a mount) says nothing when
	 * it is refused (the state says what happened); one a person asked for says why.
	 */
	refresh(opts?: { reprobe?: boolean; quiet?: boolean }): Promise<void>;
	/** Test one connection again (null: nothing was tested). */
	probe(key: string): Promise<IProbeResult | null>;
	/** Tool calls on the connection's anchor token (its console controller's), or null while nothing may be sent. */
	session(endpoint: IExplorerEndpoint): IVectorCaller | null;
	/** The role channels the connection's panels call through (null for a role this mount cannot reach). */
	channels(endpoint: IExplorerEndpoint): VectorChannels;
	/**
	 * The objects of one connection in this mount (console controller, selection, tab, scope), made on first use and
	 * refreshed in place with the live endpoint, this env's way of calling it and the node's limits.
	 */
	connection(endpoint: IExplorerEndpoint, limits: IVectorLimits): IConnectionEntry;
	/** The objects of a connection, when this mount made them. */
	existingConnection(key: string): IConnectionEntry | undefined;
	/** The console model as this mount can serve it (a dev-tool frame switches chat and uploads off, with the reason). */
	consoleModel(model: ConsoleModel): ConsoleModel;
	/** Open (or focus) the console of a connection. Only ever on a user action. */
	openConsole(endpoint: IExplorerEndpoint): void;
	/** Open (or focus) one stored document, optionally at a chunk. Only ever on a user action. */
	openDocument(endpoint: IExplorerEndpoint, objectId: string, path: string | null, chunkId?: number): void;
	/** The connection the fronted document belongs to (the sidebar and the full app's dialog host follow it). */
	activeConnection: IReadable<string | null>;
	/** What this mount cannot serve and why: null in the full app (and the controller). */
	degraded: IDegraded | null;
}

/** No role channel at all (not connected). */
export const NO_CHANNELS: VectorChannels = Object.freeze({ tools: null, chat: null, ingest: null });

// =============================================================================
// DEGRADATIONS (R11): what a dev-tool mount cannot serve
// =============================================================================

/** The chat's note in a dev-tool mount. */
export const DEVTOOL_CHAT_NOTE = 'Chat is not available in the dev-tool mount: the host brokers no chat request for store tools. Open Vector Explorer as an app to use it.';

/** The upload area's note in a dev-tool mount. */
export const DEVTOOL_UPLOADS_NOTE = 'Adding documents is not available in the dev-tool mount: the host brokers no file upload for store tools. Open Vector Explorer as an app to use it.';

/** What a dev-tool frame says it cannot serve. */
export const DEVTOOL_DEGRADED: IDegraded = Object.freeze({ chat: DEVTOOL_CHAT_NOTE, uploads: DEVTOOL_UPLOADS_NOTE });

/** Served models, by the model they were made from (so a model served twice is the same object). */
const served = new WeakMap<ConsoleModel, ConsoleModel>();

/**
 * The console model as a dev-tool frame serves it: chat and uploads switched off with the dev-tool notes (the host
 * brokers neither `client.chat` nor a file upload), everything else as built. The panels stay mounted and say why.
 *
 * @param model - The model as built (vector/consoleModel.ts).
 * @returns The served model (the same object for the same model).
 */
export function devToolConsoleModel(model: ConsoleModel): ConsoleModel {
	if (model.chat.reason === DEVTOOL_CHAT_NOTE && model.ingest.reason === DEVTOOL_UPLOADS_NOTE) return model;
	const known = served.get(model);
	if (known) return known;
	const next: ConsoleModel = { ...model, chat: { enabled: false, reason: DEVTOOL_CHAT_NOTE }, ingest: { enabled: false, reason: DEVTOOL_UPLOADS_NOTE } };
	served.set(model, next);
	return next;
}

// =============================================================================
// THE LIVE ENDPOINT OF A DOCUMENT
// =============================================================================

/** What a stopped document says. */
export const STOPPED_DETAIL = 'This pipeline is no longer running. Start it, then refresh the connections.';

/**
 * The live endpoint for a document: the store's current record when it has one (a restarted pipeline shows its new
 * state), else what the document was opened with, marked stopped when a successful discovery no longer lists it.
 *
 * @param opened - The endpoint the document was opened with.
 * @param state - The discovery status and endpoints.
 * @returns The endpoint to show.
 */
export function liveEndpoint(opened: IExplorerEndpoint, state: Pick<IEndpointState, 'status' | 'endpoints'>): IExplorerEndpoint {
	const live = state.endpoints.find((e) => e.key === opened.key);
	if (live) return live;
	if (state.status === 'ready') return { ...opened, state: 'stopped', stateDetail: STOPPED_DETAIL };
	return opened;
}
