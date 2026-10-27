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
// SQL-UI — DEV-TOOL FRAME (one host document per connection, no inner tabs)
// =============================================================================
//
// The `devToolFrame` mount. Its docKey routes it (R8, sqlFrame.ts routeDocKey):
//
//   undefined / ''        the generic frame: a landing state, plus the
//                         sidebar-requested dialogs;
//   edit:<id> / edit:*new*  the connection editor;
//   <saved connection id> that connection's workbench ("not found" once the
//                         list is read and has no such id).
//
// FRAMES HOLD NO ROCKETRIDE CLIENT, and this module imports nothing that
// does (a test pins the import graph). Every engine call is an op on the
// controller (sqlFrame.ts, sqlEnv.ts REMOTE); run/apply enablement is the
// host's `host:connection` snapshot. The frame's identity guard closes the
// document when the controller's signed-in identity changes.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DevToolProps, ToolChannel } from 'shell';
import { EmptyState, useConnectionReady } from 'shell';
import { useConnectionRecord } from './connectionRecord';
import type { SqlEndpoint } from './connect';
import { setActiveConnection } from './navigation';
import { SQL_TOOL_PROTOCOL, frameChannel } from './sqlBridge';
import { attachSqlFrame, connectionDocState, directReleaseKey, followControllerReady, frameGates, routeDocKey, sqlChannel } from './sqlFrame';
import { followSignIn } from 'shared/explorer/devtool/frameIdentity';
import type { SignInState } from 'shared/explorer/devtool/frameIdentity';
import type { IControllerSummon, SummonState } from 'shared/explorer/devtool/summon';
import type { SqlFrameMount } from './sqlFrame';
import { createRemoteHistory } from './history/remoteHistory';
import type { RemoteHistory } from './history/remoteHistory';
import { createRemoteSavedQueries } from './history/remoteSavedQueries';
import type { RemoteSavedQueries } from './history/remoteSavedQueries';
import { SqlEnvProvider, createRemoteSqlEnv, useSqlEnv } from './sqlEnv';
import ConnectionView from './views/ConnectionView';
import ConnectionOverlays from './components/ConnectionOverlays';
import ConnectionEditorBody from './components/ConnectionEditorBody';
import LiveRegion from './components/LiveRegion';
import { DatabaseIcon } from './icons';

const styles = {
	// Centred empty state.
	welcome: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
};

// Overlay-host claim: sidebar-requested dialogs (add/edit/delete connection)
// must render in exactly ONE frame per realm. In VS Code each frame is its
// own document (always one host). In-shell, several connection frames share
// the realm — the first alive mount holds the claim and it transfers when
// that mount closes.
const overlayHosts: Array<() => void> = [];

/** Whether THIS mount currently owns the overlay-host claim. */
function useOverlayHostClaim(): boolean {
	const [, force] = useState(0);
	const tickRef = useRef<(() => void) | null>(null);
	if (!tickRef.current) tickRef.current = () => force((n) => n + 1);
	useEffect(() => {
		const tick = tickRef.current!;
		overlayHosts.push(tick);
		overlayHosts.forEach((fn) => fn());
		return () => {
			const at = overlayHosts.indexOf(tick);
			if (at >= 0) overlayHosts.splice(at, 1);
			overlayHosts.forEach((fn) => fn());
		};
	}, []);
	return overlayHosts[0] === tickRef.current;
}

/** The sidebar-requested dialogs, rendered by the claim-holding mount only. */
const OverlayHost: React.FC = () => {
	const owns = useOverlayHostClaim();
	return owns ? <ConnectionOverlays /> : null;
};

/**
 * One connection's workbench as a host document: resolves the saved
 * connection named by the doc key (direct mode materialises its temp tool
 * pipeline), then renders the paged ConnectionView — Overview / Insights /
 * Diagram, plus Query / Data / Design as they are used. No inner documents.
 *
 * @param props.connId - The saved connection's id (the host document key).
 * @param props.sidebarClosed - The engine is reachable but the tool's controller (its sidebar) is not ready.
 * @param props.hostKnown - The host has published `host:connection` (until then the document waits).
 * @param props.starting - The engine is reachable and the controller is being summoned (inside the summon's grace).
 * @param props.signedOut - The controller is up but vouches for no one.
 * @param props.onOpenError - Tell the sidebar this connection could not be opened.
 */
const SqlConnectionDocument: React.FC<{ connId: string; sidebarClosed: boolean; hostKnown: boolean; starting: boolean; signedOut: boolean; onOpenError: (message: string) => void }> = ({ connId, sidebarClosed, hostKnown, starting, signedOut, onOpenError }) => {
	const env = useSqlEnv();
	const { record: conn, status } = useConnectionRecord(connId);
	const [endpoint, setEndpoint] = useState<SqlEndpoint | null>(null);
	const [resolveError, setResolveError] = useState<string | null>(null);

	// Resolve the endpoint whenever the record (or the connection) changes.
	// In a dev-tool frame this is a controller op — the temp pipeline (and
	// its revival) lives in the CONTROLLER realm, never here.
	useEffect(() => {
		if (!env.ready || !conn) return;
		let alive = true;
		setResolveError(null);
		env.resolveEndpoint(conn)
			.then((ep) => { if (alive) setEndpoint(ep); })
			.catch((err: unknown) => {
				if (!alive) return;
				const message = err instanceof Error ? err.message : String(err);
				setResolveError(message);
				// The sidebar's row shows "opening…" until the connection comes to
				// front or this arrives.
				onOpenError(message);
			});
		return () => { alive = false; };
	}, [env, conn, onOpenError]);

	// Publish the active connection for the sidebar's schema tree.
	const endpointKey = endpoint?.key ?? null;
	useEffect(() => {
		if (endpointKey !== null) setActiveConnection(endpointKey);
	}, [endpointKey]);

	// Stop a direct connection's temp pipeline when its document goes away,
	// and only then: a re-resolve (a list republish, a controller remount)
	// gives a new endpoint object with the same key, and a new env (the
	// ready flag flips) is not a close either. Keyed on the endpoint KEY; the
	// env is read through a ref. The 15-minute idle TTL backstops teardowns
	// this cleanup never sees.
	const envRef = useRef(env);
	useEffect(() => { envRef.current = env; }, [env]);
	const releaseKey = directReleaseKey(endpoint);
	useEffect(() => {
		if (releaseKey === null) return undefined;
		return () => { envRef.current.releaseEndpoint(connId, releaseKey); };
	}, [releaseKey, connId]);

	let body: React.ReactNode;
	switch (connectionDocState({ ready: env.ready, sidebarClosed, hostKnown, summoning: starting, signedOut, listStatus: status, found: conn !== null, failed: resolveError !== null, opened: endpoint !== null })) {
		case 'no-sidebar':
			body = <SidebarClosed />;
			break;
		case 'waiting':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Waiting for the server connection…" description="This connection opens once the host reports the server connection." /></div>;
			break;
		case 'starting':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Starting SQL Explorer…" description="The SQL Explorer sidebar is starting. This connection opens once it is ready." /></div>;
			break;
		case 'signed-out':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Waiting for sign-in" description="Sign in to RocketRide to open this connection." /></div>;
			break;
		case 'not-connected':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Not connected" description="Connect to a RocketRide server to open this connection." /></div>;
			break;
		case 'failed':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Could not open connection" description={resolveError ?? ''} /></div>;
			break;
		case 'not-found':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Connection not found" description="This saved connection no longer exists." /></div>;
			break;
		case 'loading':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Loading…" description="Reading your saved connections." /></div>;
			break;
		case 'opening':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title={conn?.name ?? ''} description="Opening the connection…" /></div>;
			break;
		default:
			body = endpoint ? <ConnectionView endpoint={endpoint} /> : null;
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}>
			{body}
			{/* Sidebar-requested dialogs — one host per realm (see the claim). */}
			<OverlayHost />
		</div>
	);
};

/** A document that cannot open yet because the tool's sidebar (its controller) is not open. */
const SidebarClosed: React.FC = () => (
	<div style={styles.welcome}>
		<EmptyState icon={<DatabaseIcon />} title="Open the SQL Explorer sidebar to connect" description="The sidebar holds the connection for every SQL Explorer document. This document opens once the sidebar is open." />
	</div>
);

/**
 * Whether the tool's controller is ready (see followControllerReady).
 *
 * @param channel - The frame's channel.
 * @returns True while its readiness state carries a nonce.
 */
function useControllerReady(channel: ToolChannel): boolean {
	const [ready, setReady] = useState(false);
	useEffect(() => followControllerReady(channel, setReady), [channel]);
	return ready;
}

/**
 * What the controller says about the account (see followSignIn).
 *
 * @param channel - The frame's channel.
 * @returns 'pending' until it publishes, then 'nobody' or 'signed-in'.
 */
function useSignIn(channel: ToolChannel): SignInState {
	const [state, setState] = useState<SignInState>('pending');
	useEffect(() => followSignIn(channel, setState), [channel]);
	return state;
}

/**
 * Where the frame's summon of its controller stands.
 *
 * @param summon - The frame mount's summon (null before the mount exists).
 * @returns 'summoning' until there is a summon to follow.
 */
function useSummonState(summon: IControllerSummon | null): SummonState {
	const [state, setState] = useState<SummonState>(() => summon?.state() ?? 'summoning');
	useEffect(() => {
		if (!summon) return undefined;
		setState(summon.state());
		return summon.subscribe(setState);
	}, [summon]);
	return state;
}

/**
 * Dev-tool FRAME. With a `docKey` (a saved connection id, opened through
 * DevToolProps.documents) it renders that connection's workbench; `edit:…`
 * renders the connection editor; without one — the tool's generic document —
 * it shows the landing state. The connections list lives in the HOST's
 * sidebar panel (SqlDevToolSidebar, the controller).
 */
export const SqlDevTool: React.FC<DevToolProps> = ({ peer, channel, docKey, documents }) => {
	// The frame's channel (the host's, or one per peer) and its wiring: the
	// frame caller, the realm's read-only connection replica, the active-key
	// pushes, and the identity guard — mounted in an effect, disposed with it.
	const toolChannel = useMemo(() => frameChannel(peer, channel), [peer, channel]);
	// The host's documents API, read at call time: a new object on a re-render
	// must not remount the frame wiring (which drops pending calls).
	const documentsRef = useRef(documents);
	useEffect(() => { documentsRef.current = documents; }, [documents]);
	const [mount, setMount] = useState<{ frame: SqlFrameMount; history: RemoteHistory; saved: RemoteSavedQueries } | null>(null);
	useEffect(() => {
		let history: RemoteHistory | null = null;
		let saved: RemoteSavedQueries | null = null;
		const frame = attachSqlFrame({
			peer,
			channel: toolChannel,
			docKey: docKey ?? null,
			documents: {
				open: (key, title) => documentsRef.current?.open(key, title),
				close: (key) => documentsRef.current?.close(key),
			},
			protocol: SQL_TOOL_PROTOCOL,
			// Identity changed, unknown, or the host connection dropped: the
			// frame wiring clears the realm's schemas; the history and
			// saved-queries views are ours.
			onReset: () => {
				history?.reset();
				saved?.reset();
			},
		});
		history = createRemoteHistory({ caller: frame.caller, channel: sqlChannel(frame.channel), owner: frame.owner });
		saved = createRemoteSavedQueries({ caller: frame.caller, channel: sqlChannel(frame.channel), owner: frame.owner });
		setMount({ frame, history, saved });
		return () => {
			saved?.dispose();
			history?.dispose();
			frame.dispose();
		};
	}, [peer, toolChannel, docKey]);

	// FRAMES HOLD NO ROCKETRIDE CLIENT: run/apply enablement is the host's
	// `host:connection` snapshot, and every call is a controller op.
	// ...and a controller that is ready (the sidebar is open: otherwise a call
	// would wait and time out unsent), and a signed-in account it vouches for
	// (otherwise a frame's own first calls, opening its connection and the
	// first schema read, would only be refused as "not signed in", and
	// announced).
	// `host:connection` is tri-state (#2625): undefined until the host's first
	// snapshot. The gates treat that as not ready; the document says it is
	// waiting rather than that the server is unreachable.
	const hostConnection = useConnectionReady(toolChannel);
	const controllerReady = useControllerReady(toolChannel);
	// While no controller is ready the frame summons one (F11); it says to open
	// the sidebar only once the summon's grace ran out, "starting" before that.
	const summon = useSummonState(mount?.frame.summon ?? null);
	// The account (F12): 'nobody' says "waiting for sign-in", never "not connected".
	const signIn = useSignIn(toolChannel);
	const gates = frameGates({ host: hostConnection, controllerReady, summon, signIn });
	const env = useMemo(() => (mount ? createRemoteSqlEnv(mount.frame.caller, gates.ready, mount.frame.owner, mount.history, mount.saved) : null), [mount, gates.ready]);
	const onOpenError = useCallback((message: string) => sqlChannel(toolChannel).sendEvent('openError', message), [toolChannel]);

	if (!env) return null;
	const route = routeDocKey(docKey);
	let body: React.ReactNode;
	if (route.kind === 'editor') {
		body = (
			<ConnectionEditorBody
				connId={route.connId}
				sidebarClosed={gates.sidebarClosed}
				starting={gates.starting}
				signedOut={gates.signedOut}
				onCloseSelf={() => { if (docKey) documents?.close(docKey); }}
				onOpenSaved={(saved) => documents?.open(saved.id, saved.name)}
			/>
		);
	} else if (route.kind === 'connection') {
		body = <SqlConnectionDocument connId={route.connId} sidebarClosed={gates.sidebarClosed} hostKnown={gates.hostKnown} starting={gates.starting} signedOut={gates.signedOut} onOpenError={onOpenError} />;
	} else {
		body = (
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
				<div style={styles.welcome}>
					<EmptyState icon={<DatabaseIcon />} title="SQL Explorer" description="Open a connection from the sidebar, or add a database with + New Connection: pick a database node from a pipeline you are running, or enter the connection details directly." />
				</div>
				<OverlayHost />
			</div>
		);
	}
	return (
		<SqlEnvProvider value={env}>
			{/* The realm's one live region (the first alive mount renders it). */}
			<LiveRegion />
			{body}
		</SqlEnvProvider>
	);
};

export default SqlDevTool;
