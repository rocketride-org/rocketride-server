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
// SQL FRAME — the document side of the tool protocol (every devToolFrame mount)
// =============================================================================
//
// A frame holds NO RocketRide client (R1). Everything engine-facing is an op
// on the controller (ops.ts), called through the dev-tool library's frame
// caller (shared/explorer/devtool/frame):
//
//   - every call names an explicit timeout (sqlTimeouts.ts) and is stamped
//     with `deadlineAt`, which the controller enforces;
//   - when `host:connection` turns false, pending calls are rejected at once
//     (they may still have run), and a call made while it is false is not
//     sent at all;
//   - a Reply failure comes back as the controller's ExplorerToolError.
//
// What a frame follows on its channel:
//
//   STATE  'connections'   the controller's saved-connection list, applied as
//                          this realm's READ-ONLY replica (a frame never reads
//                          or writes the user's file; saves and deletes are
//                          ops). Ref-counted per realm: any number of frames,
//                          one wiring.
//   STATE  'identity'      the fingerprint the controller vouches for; the
//                          frame's identity guard closes the document and
//                          resets the frame's caches when it changes (R9).
//   EVENT  'active'        sent: this realm's active endpoint key, on change
//                          and when the document becomes visible (the
//                          sidebar's fallback while the host's activeDocKey
//                          is unknown).
//   EVENT  'openError'     sent: a connection this document could not open.
//
// Plain functions over injected protocol factories (R15): sqlBridge.ts hands
// the shell's real ones to the React mount, tests the real modules.
// =============================================================================

import type { DevToolProps, IToolOpServer, ToolChannel, ToolControllerFn, ToolOpMap, TypedToolChannel } from 'shell';
import { createFrameCaller } from 'shared/explorer/devtool/frame';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import { createFrameIdentityGuard } from 'shared/explorer/devtool/frameIdentity';
import type { FrameResetReason } from 'shared/explorer/devtool/frameIdentity';
import { channelFor, CONTROLLER_STATE_TOPIC } from 'shared/explorer/devtool/realm';
import { createControllerSummon } from 'shared/explorer/devtool/summon';
import type { IControllerSummon, SummonState } from 'shared/explorer/devtool/summon';
import type { SignInState } from 'shared/explorer/devtool/frameIdentity';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { applyReplicaConnections, isDirectEndpointKey } from './connect';
import type { SavedConnectionsStatus, SqlEndpoint } from './connect';
import { parseConnectionEditorDocKey } from './docs';
import { getActiveConnection, subscribeActiveConnection } from './navigation';
import { clearSchemas } from './schema/schemaStore';
import type { SqlEventMap, SqlOps, SqlStateMap } from './ops';

// =============================================================================
// PROTOCOL FACTORIES (injected)
// =============================================================================

/** The shell's tool-protocol factories (sqlBridge.ts SQL_TOOL_PROTOCOL; the real modules in tests). */
export interface SqlToolProtocol {
	/** Build a channel over a peer. */
	createToolChannel: (peer: DevToolPeer) => ToolChannel;
	/** Build a frame's controller function over a peer. */
	createToolController: <O extends ToolOpMap>(peer: DevToolPeer) => ToolControllerFn<O>;
	/** Build the controller's op server over a peer. */
	createToolOpServer: <O extends ToolOpMap>(peer: DevToolPeer) => IToolOpServer<O>;
}

/**
 * A channel as the tool's typed protocol view (a cast; `typedToolChannel` from
 * 'shell' does the same, without a value import here).
 *
 * @param channel - The channel.
 * @returns The same channel, typed.
 */
export function sqlChannel(channel: ToolChannel): TypedToolChannel<SqlStateMap, SqlEventMap> {
	return channel as unknown as TypedToolChannel<SqlStateMap, SqlEventMap>;
}

// =============================================================================
// DOCUMENT KEYS (R8)
// =============================================================================

/** What a frame shows for its docKey. */
export type SqlDocRoute =
	/** The generic frame (VS Code passes undefined, rocket-ui ''). */
	| { kind: 'landing' }
	/** The connection editor: `edit:<id>`, or `edit:*new*` (connId null). */
	| { kind: 'editor'; connId: string | null }
	/** A saved connection's workbench: the docKey IS its id. An unknown id renders "not found". */
	| { kind: 'connection'; connId: string };

/**
 * Route a frame's docKey.
 *
 * @param docKey - DevToolProps.docKey.
 * @returns What to render.
 */
export function routeDocKey(docKey: string | null | undefined): SqlDocRoute {
	if (typeof docKey !== 'string' || docKey === '') return { kind: 'landing' };
	const editor = parseConnectionEditorDocKey(docKey);
	if (editor) return { kind: 'editor', connId: editor.connId };
	return { kind: 'connection', connId: docKey };
}

/**
 * What a connection document's release is keyed on: a direct connection's
 * endpoint key (its temp pipeline is stopped when the document goes away),
 * or null (nothing to release: a pipeline connection, or not opened yet).
 * The KEY, not the endpoint object: every re-resolve makes a new object for
 * the same pipeline.
 *
 * @param endpoint - The document's endpoint, if it opened.
 * @returns The key to release on, or null.
 */
export function directReleaseKey(endpoint: SqlEndpoint | null): string | null {
	return endpoint !== null && isDirectEndpointKey(endpoint.key) ? endpoint.key : null;
}

/** What a frame's documents may do and say. */
export interface FrameGates {
	/** The frame may call: the host is connected, the controller is ready and vouches for an account. */
	ready: boolean;
	/** The host has published `host:connection` (until then a document waits). */
	hostKnown: boolean;
	/** The summon was never answered (its grace ran out): say to open the sidebar. */
	sidebarClosed: boolean;
	/** The controller is being summoned, or is up but has not said who is signed in yet: say it is starting. */
	starting: boolean;
	/** The controller vouches for no one (its retained identity): say it is waiting for sign-in. */
	signedOut: boolean;
}

/**
 * Turn what a frame follows into what its documents may do and say (rules
 * F11-F13 of the dev-tool parity spec). With the host connected, no
 * combination says "not connected": a controller that has not said who is
 * signed in yet is still starting.
 *
 * @param input - What the frame follows.
 * @param input.host - The host's `host:connection` (undefined before its first snapshot).
 * @param input.controllerReady - The controller published a readiness nonce.
 * @param input.summon - Where the frame's summon of its controller stands.
 * @param input.signIn - What the controller says about the account.
 * @returns The gates.
 */
export function frameGates(input: { host: boolean | undefined; controllerReady: boolean; summon: SummonState; signIn: SignInState }): FrameGates {
	const engineReady = input.host === true;
	return {
		ready: engineReady && input.controllerReady && input.signIn === 'signed-in',
		hostKnown: input.host !== undefined,
		sidebarClosed: engineReady && !input.controllerReady && input.summon === 'unanswered',
		starting: engineReady && (input.controllerReady ? input.signIn === 'pending' : input.summon !== 'unanswered'),
		// From the controller's retained identity alone: it outlives a remount, so a
		// summon gap does not bring an open document back to a signed-out user.
		signedOut: engineReady && input.signIn === 'nobody',
	};
}

/** What a connection document shows. */
export type ConnectionDocState = 'waiting' | 'not-connected' | 'starting' | 'no-sidebar' | 'signed-out' | 'failed' | 'not-found' | 'loading' | 'opening' | 'open';

/**
 * Decide what a connection document shows. An id the list does not hold is
 * "not found" only once the list has been read; before that it is loading.
 *
 * @param input - What the document knows.
 * @param input.ready - The frame may call: the engine is reachable (`host:connection`), the controller is ready and vouches for an account.
 * @param input.sidebarClosed - The engine is reachable but no controller is ready (the sidebar was never opened, or was closed): a document not yet open says to open the sidebar; an open one stays.
 * @param input.hostKnown - Whether the host has published `host:connection` yet (frames only). `false` means no snapshot has arrived, which says nothing about the server: the document waits instead of claiming it is not connected.
 * @param input.summoning - The engine is reachable and the controller is being summoned (inside the summon's grace): a document not yet open says it is starting; an open one stays.
 * @param input.signedOut - The engine is reachable and the controller is up, but it vouches for no one: "waiting for sign-in", not "not connected".
 * @param input.listStatus - The saved-connection list's status.
 * @param input.found - The list holds the document's connection id.
 * @param input.failed - Opening it failed.
 * @param input.opened - It resolved to an endpoint.
 * @returns The state.
 */
export function connectionDocState(input: { ready: boolean; sidebarClosed?: boolean; hostKnown?: boolean; summoning?: boolean; signedOut?: boolean; listStatus: SavedConnectionsStatus; found: boolean; failed: boolean; opened: boolean }): ConnectionDocState {
	// An open document stays open (run and apply are disabled) while its
	// controller is being summoned or never answered; one that has not opened
	// says it is starting, then (after the summon's grace) to open the sidebar.
	// ...unless nobody is signed in: its view was already replaced, so a summon
	// gap must not bring it back.
	const keepOpen = input.opened && !input.failed && input.signedOut !== true;
	const signedOutOpen = input.signedOut === true && input.opened;
	if (input.sidebarClosed === true) return keepOpen ? 'open' : signedOutOpen ? 'signed-out' : 'no-sidebar';
	if (!input.ready) {
		if (input.hostKnown === false) return 'waiting';
		if (input.summoning === true) return keepOpen ? 'open' : signedOutOpen ? 'signed-out' : 'starting';
		if (input.signedOut === true) return 'signed-out';
		return 'not-connected';
	}
	if (input.failed) return 'failed';
	if (!input.found) return input.listStatus === 'ready' ? 'not-found' : 'loading';
	return input.opened ? 'open' : 'opening';
}

// =============================================================================
// THE REALM'S DOCUMENT HOST (ref-counted)
// =============================================================================

/** The realm's single document-host wiring teardown (ref-counted). */
let documentHostDetach: (() => void) | null = null;
/** Frame mounts attached in this realm (any number share ONE wiring). */
let documentHosts = 0;

/**
 * Attach the document side of the protocol for this realm: apply the
 * controller's retained connection list as a read-only replica, and announce
 * this realm's active endpoint. REF-COUNTED: any number of frames may call
 * it, exactly one wiring exists.
 *
 * @param channel - The frame's channel.
 * @returns Detach (the last detach tears the wiring down).
 */
export function attachSqlDocumentHost(channel: ToolChannel): () => void {
	documentHosts++;
	if (documentHosts === 1) documentHostDetach = wireSqlDocumentHost(sqlChannel(channel), channel);
	let detached = false;
	return () => {
		if (detached) return;
		detached = true;
		documentHosts--;
		if (documentHosts === 0) {
			documentHostDetach?.();
			documentHostDetach = null;
		}
	};
}

/**
 * The one-per-realm wiring behind {@link attachSqlDocumentHost}.
 *
 * @param channel - The typed channel.
 * @returns Teardown.
 */
function wireSqlDocumentHost(channel: TypedToolChannel<SqlStateMap, SqlEventMap>, raw: ToolChannel): () => void {
	// The controller's list, applied as a READ-ONLY replica (no writer, so a
	// mutation attempted in this realm is refused by the store). A list the
	// controller has not read (no identity, still loading) is shown as loading.
	// A realm that also hosts the controller (rocket-ui) owns the list, and a
	// snapshot never overwrites it there.
	const offConnections = channel.onState('connections', (snapshot) => applyReplicaConnections(snapshot));

	// Announce this realm's active endpoint — on change, again whenever the
	// document becomes visible (in VS Code each connection is its own webview
	// panel, and switching editor tabs changes nothing INSIDE either document,
	// so the newly fronted panel re-announces itself), and to every controller
	// that becomes ready (below). Never unconditionally at attach: with no
	// controller nobody hears it, and a ready one gets it from its readiness.
	// (Hosts with activeDocKey override this signal; it remains the fallback.)
	let lastActive: string | null | undefined;
	const pushActive = (): void => {
		const key = getActiveConnection();
		if (key === lastActive) return;
		lastActive = key;
		channel.sendEvent('active', key);
	};
	const offActive = subscribeActiveConnection(pushActive);
	const doc = typeof document !== 'undefined' ? document : null;
	const onVisible = (): void => {
		if (doc?.visibilityState !== 'visible') return;
		lastActive = getActiveConnection();
		channel.sendEvent('active', lastActive);
	};
	doc?.addEventListener('visibilitychange', onVisible);

	// ...and again to every controller that becomes ready: a frame's summon
	// event takes the peer's single retained slot, and the channel a host
	// builds for a summon-driven mount takes the held burst, so a controller
	// may never have heard the last announcement.
	let lastNonce: string | null = null;
	const offReady = raw.onState(CONTROLLER_STATE_TOPIC, (snapshot: unknown) => {
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { ready?: unknown }).ready : undefined;
		const nonce = typeof value === 'string' && value !== '' ? value : null;
		if (nonce === lastNonce) return;
		lastNonce = nonce;
		if (nonce === null) return;
		// A realm with no active connection has nothing to say to a new
		// controller (a null would clear the highlight another realm set).
		const key = getActiveConnection();
		if (key === null) return;
		lastActive = undefined;
		pushActive();
	});

	return () => {
		offConnections();
		offActive();
		offReady();
		doc?.removeEventListener('visibilitychange', onVisible);
	};
}

// =============================================================================
// ONE FRAME MOUNT
// =============================================================================

/**
 * Follow whether the tool's controller is ready to serve (its readiness state,
 * published by the library under the reserved `devtool:controller` topic).
 * It is not when the sidebar was never opened (a document restored at
 * startup) or was closed: the frame then says to open the sidebar, instead of
 * waiting for calls that would time out unsent.
 *
 * @param channel - The frame's channel.
 * @param onChange - Told on every snapshot (the retained one at once).
 * @returns Stop following.
 */
export function followControllerReady(channel: ToolChannel, onChange: (ready: boolean) => void): () => void {
	return channel.onState(CONTROLLER_STATE_TOPIC, (snapshot: unknown) => {
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { ready?: unknown }).ready : undefined;
		onChange(typeof value === 'string' && value !== '');
	});
}

/** What a frame says when its controller never became ready. */
export const SIDEBAR_CLOSED_TEXT = 'The SQL Explorer sidebar is not open, so nothing was sent. Open the sidebar to connect.';

/** An op's wire name, as the library quotes it in its own messages. */
const QUOTED_OP = /'sql\.[A-Za-z]+'/g;

/**
 * The library's own failure texts name the op's wire name (`'sql.execute'
 * was not sent…`). People see and hear these (the failure banner speaks its
 * headline), so the wire name becomes "the request", and a call that waited
 * for a controller that never became ready says to open the sidebar. Kind,
 * code and tool are kept.
 *
 * @param error - What a frame call rejected with.
 * @returns The error to show.
 */
export function plainFrameError(error: unknown): unknown {
	if (!(error instanceof ExplorerToolError) || error.message.search(QUOTED_OP) < 0) return error;
	const message = /was not sent: the tool's controller did not become ready/.test(error.message)
		? SIDEBAR_CLOSED_TEXT
		: error.message.replace(/^'sql\.[A-Za-z]+'/, 'The request').replace(QUOTED_OP, 'the request');
	return new ExplorerToolError({ kind: error.kind, tool: error.tool, message, ...(error.code !== undefined ? { code: error.code } : {}) });
}

/**
 * A frame caller whose failures read as {@link plainFrameError} says.
 *
 * @param caller - The library's caller.
 * @returns The same caller, failures reworded.
 */
function plainSpoken<O extends ToolOpMap>(caller: IFrameCaller<O>): IFrameCaller<O> {
	const reword = (error: unknown): never => { throw plainFrameError(error); };
	return {
		call: (op, params, opts) => caller.call(op, params, opts).catch(reword),
		callReply: (op, params, opts) => caller.callReply(op, params, opts).catch(reword),
		pending: () => caller.pending(),
		connected: () => caller.connected(),
		controllerReady: () => caller.controllerReady(),
		dispose: () => caller.dispose(),
	};
}

/**
 * Follow whether the controller vouches for a signed-in account: its retained
 * `identity` state carries a fingerprint. A frame calls nothing on its own
 * (a first schema read, opening its connection) until it does: before that,
 * the controller would only answer "not signed in", and the frame would show
 * and announce a refusal the next snapshot makes moot.
 *
 * @param channel - The frame's channel.
 * @param onChange - Told on every snapshot (the retained one at once).
 * @returns Stop following.
 */
export function followVouched(channel: ToolChannel, onChange: (vouched: boolean) => void): () => void {
	return sqlChannel(channel).onState('identity', (snapshot: unknown) => {
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { fingerprint?: unknown }).fingerprint : undefined;
		onChange(typeof value === 'string' && value !== '');
	});
}

/** What {@link attachSqlFrame} needs (DevToolProps plus the injected factories). */
export interface SqlFrameOptions {
	/** The frame's peer. */
	peer: DevToolPeer;
	/** The host's channel for this mount, when it gave one. */
	channel?: ToolChannel;
	/** The frame's docKey. */
	docKey?: string | null;
	/** The host's documents API (closing this document on an identity change). */
	documents?: DevToolProps['documents'];
	/** The protocol factories. */
	protocol: SqlToolProtocol;
	/**
	 * Clear what the mount holds for the connection (its history view) —
	 * identity change, sign-out, a dropped connection. The realm's schema
	 * snapshots are cleared before it is called.
	 */
	onReset?: (reason: FrameResetReason) => void;
	/** The summon's scheduler (tests; default setTimeout). */
	summonSchedule?: (fn: () => void, ms: number) => () => void;
	/** The clock deadlines are stamped from (tests). */
	now?: () => number;
}

/** A mounted frame. */
export interface SqlFrameMount {
	/** The frame's channel. */
	readonly channel: ToolChannel;
	/** The frame's way to call its controller. */
	readonly caller: IFrameCaller<SqlOps>;
	/** The identity fingerprint this frame belongs to (the first it saw), or null before one arrived. */
	owner(): string | null;
	/** Summons the controller while it is not ready (shared/explorer/devtool/summon). */
	readonly summon: IControllerSummon;
	/** Detach (the effect's cleanup): pending calls are dropped as stale. */
	dispose(): void;
}

/**
 * Wire one frame mount.
 *
 * @param opts - See {@link SqlFrameOptions}.
 * @returns The mount; dispose it in the effect's cleanup.
 */
export function attachSqlFrame(opts: SqlFrameOptions): SqlFrameMount {
	const { peer, protocol } = opts;
	const channel = opts.channel ?? channelFor(peer, protocol.createToolChannel);
	const caller = plainSpoken(createFrameCaller<SqlOps>({
		peer,
		channel,
		createToolController: protocol.createToolController,
		createToolChannel: protocol.createToolChannel,
		...(opts.now ? { now: opts.now } : {}),
	}));
	const detachHost = attachSqlDocumentHost(channel);
	const guard = createFrameIdentityGuard({
		channel,
		docKey: opts.docKey ?? null,
		...(opts.documents ? { documents: opts.documents } : {}),
		// The controller's identity changed (the guard closes this document),
		// cannot be vouched for, or the host connection dropped: forget what
		// this realm holds for the previous session, then let the mount clear
		// its own (R9).
		onReset: (reason) => {
			clearSchemas();
			opts.onReset?.(reason);
		},
	});
	// While no controller is ready, ask the host to mount one (an event, never
	// a call; quiet until its grace runs out).
	const summon = createControllerSummon({ channel, ...(opts.summonSchedule ? { schedule: opts.summonSchedule } : {}) });
	let disposed = false;
	return {
		channel,
		caller,
		owner: () => guard.first(),
		summon,
		dispose() {
			if (disposed) return;
			disposed = true;
			summon.dispose();
			guard.dispose();
			caller.dispose();
			detachHost();
		},
	};
}
