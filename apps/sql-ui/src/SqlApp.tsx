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
// SQL-UI — MAIN APP (document host: DocTabs + per-document views)
// =============================================================================
//
// The app follows the rocket-ui document model: an app-owned Documents
// instance renders DocTabs per editor group, and this component routes each
// document URI to its view — one workbench doc per open connection plus its
// query/table/designer/diagram documents. Connections are added and opened
// from the SIDEBAR (saved-connection list + New Connection modal); there is
// no landing document any more (2026-10-14). A direct-mode connection's temp
// tool pipeline is stopped when its last document closes.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DevToolProps, ShellAppProps } from 'shell';
import { DocTabs, DocSplitLayout, AppLayout, useShellConnection } from 'shell';
import type { Documents } from 'shell';
import { EmptyState } from 'shell';
import { commonStyles } from 'shell';
import { closeDocumentByUri, connectionEditorIdFromUri, createDocs, destroyDocs, endpointKeyFromAnyUri, endpointKeyFromUri, getDocs, isConnectionEditorUri, isDesignUri, isDiagramUri, isQueryUri, isTableDataUri, parseConnectionEditorDocKey } from './docs';
import type { IQueryDocPayload } from './docs';
import { setActiveConnection } from './navigation';
import { loadSavedConnections, resetSavedConnections, releaseDirectEndpoint, isDirectEndpointKey, resolveEndpoint, useSavedConnections, useSavedConnectionsStatus } from './connect';
import type { SavedSqlConnection } from './connect';
import { attachSqlDocumentHost, localSidebarBridge, sendConnectionSave } from './sqlBridge';
import type { ISqlEndpoint } from './connect';
import ConnectionView from './views/ConnectionView';
import ConnectionOverlays from './components/ConnectionOverlays';
import NewConnectionModal from './components/NewConnectionModal';
import QueryView from './views/QueryView';
import TableDataView from './views/TableDataView';
import TableDesignView from './views/TableDesignView';
import DiagramView from './views/DiagramView';
import SqlSidebar from './SqlSidebar';
import LiveRegion from './components/LiveRegion';
import { HistoryPrefsBridge } from './history/historyStore';
import { DatabaseIcon } from './icons';

// =============================================================================
// TYPES
// =============================================================================

// The query-document payload type lives beside the URI builders in docs.ts
// (IQueryDocPayload); producers and this consumer import it from there.

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		// Flex child of the app-root row: fill it — without this the column
		// shrinks to its content's intrinsic width (visible as a narrow
		// left-aligned strip when only the welcome card is showing).
		flex: 1,
		minWidth: 0,
		height: '100%',
		overflow: 'hidden',
	} as CSSProperties,

	groupPane: {
		...commonStyles.columnFill,
		minWidth: 0,
		overflow: 'hidden',
	} as CSSProperties,

	// Editor content row under the group's DocTabs.
	content: {
		flex: 1,
		display: 'flex',
		minHeight: 0,
		minWidth: 0,
		overflow: 'hidden',
	} as CSSProperties,

	// One mounted editor pane (hidden when its tab is inactive).
	editorPane: (active: boolean): CSSProperties => ({
		display: active ? 'flex' : 'none',
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		flexDirection: 'column',
	}),

	// Empty-group welcome region.
	welcome: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * SQL Explorer — client area. Initialises the app-owned Documents instance
 * (all documents are static), auto-opens the Connections landing document,
 * and renders the DocTabs + editor-group layout.
 *
 * @param _props - Shell-injected props (unused; connection comes from hooks).
 */
const SqlApp: React.FC<ShellAppProps> = (_props) => {
	const { client, isConnected } = useShellConnection();
	const [ready, setReady] = useState(false);

	// Create the Documents instance once.
	useEffect(() => {
		createDocs();
		setReady(true);
		return () => {
			resetSavedConnections();
			destroyDocs();
			setReady(false);
		};
	}, []);

	// Load the saved-connection list from the connected server's user store —
	// per-user-per-server, so every host (app, preview, VS Code tool) sees
	// the same list. Reconnects re-load against the new server.
	useEffect(() => {
		if (client && isConnected) void loadSavedConnections(client);
	}, [client, isConnected]);

	// Sidebar node memoized once: SqlSidebar takes no props and reads all its
	// state from the shared singletons, so the slot registration is stable.
	const sidebar = useMemo(() => <SqlSidebar />, []);

	// Two-column app: the navigation/schema sidebar mounts once Documents is
	// ready (it shares the singleton with the workbench documents).
	if (!ready) return <AppLayout showStatus>{null}</AppLayout>;
	return (
		<AppLayout sidebar={sidebar} showStatus>
			<SqlAppReady docs={getDocs()!} />
			{/* Sidebar-requested dialogs render HERE, outside the sidebar
			    subtree — the compact drawer is a transformed ancestor that
			    would trap a fixed-position overlay. */}
			<ConnectionOverlays />
		</AppLayout>
	);
};

// =============================================================================
// DEV-TOOL FRAME — one host document per CONNECTION (no inner tab strip)
// =============================================================================

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
 */
const SqlConnectionDocument: React.FC<{ connId: string }> = ({ connId }) => {
	const { client, isConnected } = useShellConnection();
	const status = useSavedConnectionsStatus();
	const connections = useSavedConnections();
	const conn = connections.find((c) => c.id === connId);
	const [endpoint, setEndpoint] = useState<ISqlEndpoint | null>(null);
	const [resolveError, setResolveError] = useState<string | null>(null);

	// Resolve the endpoint whenever the record (or the connection) changes.
	useEffect(() => {
		if (!client || !isConnected || !conn) return;
		let alive = true;
		setResolveError(null);
		resolveEndpoint(client, conn)
			.then((ep) => { if (alive) setEndpoint(ep); })
			.catch((err: unknown) => { if (alive) setResolveError(err instanceof Error ? err.message : String(err)); });
		return () => { alive = false; };
	}, [client, isConnected, conn]);

	// Publish the active connection for the sidebar's schema tree, and stop a
	// direct connection's temp pipeline when its document closes (the 15-min
	// idle TTL backstops teardowns this cleanup never sees).
	useEffect(() => {
		if (!endpoint) return;
		setActiveConnection(endpoint.key);
		return () => {
			if (client && isDirectEndpointKey(endpoint.key)) void releaseDirectEndpoint(client, endpoint.key);
		};
	}, [endpoint, client]);

	let body: React.ReactNode;
	if (!isConnected) {
		body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Not connected" description="Connect to a RocketRide server to open this connection." /></div>;
	} else if (resolveError) {
		body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Could not open connection" description={resolveError} /></div>;
	} else if (!conn) {
		body = status === 'ready'
			? <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Connection not found" description="This saved connection no longer exists." /></div>
			: <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Loading…" description="Reading your saved connections." /></div>;
	} else if (!endpoint) {
		body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title={conn.name} description="Opening the connection…" /></div>;
	} else {
		body = <ConnectionView endpoint={endpoint} />;
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}>
			<LiveRegion />
			{body}
			{/* Sidebar-requested dialogs — one host per realm (see the claim). */}
			<OverlayHost />
		</div>
	);
};

/**
 * The connection editor as a document body, shared by both hosts: resolves
 * the editing target from the store and runs the page-chrome form. After a
 * NEW connection saves, `onOpenSaved` opens its workbench.
 */
const ConnectionEditorBody: React.FC<{
	/** The connection id being edited, or null for the add form. */
	connId: string | null;
	/** Close this editor document. */
	onCloseSelf: () => void;
	/** Open the workbench of a freshly added connection. */
	onOpenSaved: (saved: SavedSqlConnection) => void;
	/** Commit override for isolated documents (peer post to the owner realm). */
	commit?: (conn: SavedSqlConnection) => void;
}> = ({ connId, onCloseSelf, onOpenSaved, commit }) => {
	const connections = useSavedConnections();
	const status = useSavedConnectionsStatus();
	const editing = connId ? connections.find((c) => c.id === connId) ?? null : null;

	// An edit target that is not in the store yet (list still loading) or is
	// gone (deleted elsewhere) must not silently become an ADD form.
	if (connId && !editing) {
		return status === 'ready'
			? <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Connection not found" description="This saved connection no longer exists." /></div>
			: <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Loading…" description="Reading your saved connections." /></div>;
	}

	return (
		<NewConnectionModal
			page
			editing={editing}
			onClose={onCloseSelf}
			onSaved={(saved) => { if (!connId) onOpenSaved(saved); }}
			{...(commit ? { commit } : {})}
		/>
	);
};

/**
 * Dev-tool FRAME. With a `docKey` (a saved connection id, opened through
 * DevToolProps.documents) it renders that connection's workbench; without
 * one — the tool's generic document — it shows the landing state. The
 * connections list and schema tree live in the HOST's sidebar panel
 * (SqlDevToolSidebar); sidebar actions arrive over the peer channel and the
 * frame pushes the list + active key back (ref-counted: any number of
 * connection frames share one wiring per realm).
 */
export const SqlDevTool: React.FC<DevToolProps> = ({ peer, channel, docKey, documents }) => {
	// Document side of the tool protocol: applies the controller's retained
	// connection list as this realm's read-only replica (frames never read
	// the server file themselves), acts on controller events, announces the
	// active endpoint. Ref-counted — any number of frames, one wiring.
	useEffect(() => attachSqlDocumentHost({ peer, ...(channel ? { channel } : {}), ...(documents ? { documents } : {}) }), [peer, channel, documents]);

	// The connection editor rides its own docKey family ('edit:…'); every
	// other docKey is a saved connection id.
	const editorKey = docKey ? parseConnectionEditorDocKey(docKey) : null;
	if (docKey && editorKey) {
		return (
			<ConnectionEditorBody
				connId={editorKey.connId}
				onCloseSelf={() => documents?.close(docKey)}
				onOpenSaved={(saved) => documents?.open(saved.id, saved.name)}
				// Isolated document: the save commits in the CONTROLLER realm
				// (the owner) as a channel event.
				commit={(conn) => sendConnectionSave({ peer, ...(channel ? { channel } : {}) }, conn)}
			/>
		);
	}
	if (docKey) return <SqlConnectionDocument connId={docKey} />;
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
			<div style={styles.welcome}>
				<EmptyState icon={<DatabaseIcon />} title="SQL Explorer" description="Open a connection from the sidebar, or add one with New Connection." />
			</div>
			<OverlayHost />
		</div>
	);
};

/**
 * Inner component that renders once Documents is ready.
 * Separated so useStore() is called unconditionally.
 */
const SqlAppReady: React.FC<{ docs: Documents }> = ({ docs }) => {
	const state = docs.useStore();
	const { client } = useShellConnection();

	// Publish the active connection (for the sidebar's schema tree): the
	// active group's active editor, for ANY connection-scoped document —
	// query/table/design/diagram tabs must keep the tree bound too.
	useEffect(() => {
		const group = state.groups[state.activeGroupId];
		const editorId = group?.editorIds[group.activeEditorIndex];
		const editor = editorId ? state.editors[editorId] : undefined;
		setActiveConnection(editor ? endpointKeyFromAnyUri(editor.documentUri) : null);
	}, [state]);

	// Direct-mode lifecycle: when the LAST open document of a direct
	// connection closes (any scheme — workbench, query, table, designer,
	// diagram), stop its temporary tool pipeline. The 15-minute idle TTL is
	// the backstop for everything this cannot see (reloads, crashes).
	const openDirectKeysRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const open = new Set<string>();
		for (const editor of Object.values(state.editors)) {
			const key = endpointKeyFromAnyUri(editor.documentUri);
			if (key && isDirectEndpointKey(key)) open.add(key);
		}
		for (const key of openDirectKeysRef.current) {
			if (!open.has(key) && client) void releaseDirectEndpoint(client, key);
		}
		openDirectKeysRef.current = open;
	}, [state, client]);

	// Multiple groups exist — show the close-group affordance on tabs.
	const canCloseGroups = state.rootNode.type === 'split';

	return (
		<div style={styles.container}>
			{/* One polite live region for the whole app; announce() writes to it. */}
			<LiveRegion />

			{/* The history store only writes while a bridge is mounted. This one
			    is app-level so a query document whose connection tab was closed
			    still records; the bridge is reference-counted, so the copies in
			    ConnectionView and the drawer stay harmless. */}
			<HistoryPrefsBridge />
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;

					return (
						<div style={styles.groupPane} onClick={() => docs.setActiveGroup(groupId)}>
							{/* Tab bar for this group. */}
							<DocTabs
								docs={docs}
								groupId={groupId}
								isActive={state.activeGroupId === groupId}
								canClose={canCloseGroups}
								onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)}
								onCloseGroup={(gid) => docs.closeGroup(gid)}
							/>

							{/* Editor content — all editors stay mounted; visibility
							    toggles so per-view state survives tab switches. */}
							<div style={styles.content}>
								{group.editorIds.length === 0 ? (
									<div style={styles.welcome}>
										<EmptyState
											icon={<DatabaseIcon />}
											title="SQL Explorer"
											description="Open a connection from the sidebar, or add one with New Connection."
										/>
									</div>
								) : (
									group.editorIds.map((editorId, idx) => {
										const editor = state.editors[editorId];
										if (!editor) return null;
										const isActive = idx === group.activeEditorIndex;
										return (
											<div key={editorId} style={styles.editorPane(isActive)}>
												<DocumentPane uri={editor.documentUri} docs={docs} />
											</div>
										);
									})
								)}
							</div>
						</div>
					);
				}}
			/>
		</div>
	);
};

// =============================================================================
// DOCUMENT PANE — routes one document URI to its view
// =============================================================================

/**
 * Renders the view for a single document URI.
 *
 * @param props.uri - The document URI to render.
 * @param props.docs - The app's Documents instance (content lookup).
 */
const DocumentPane: React.FC<{ uri: string; docs: Documents }> = ({ uri, docs }) => {
	// Connection editor document (add/edit form as a top-level tab).
	if (isConnectionEditorUri(uri)) {
		return (
			<ConnectionEditorBody
				key={uri}
				connId={connectionEditorIdFromUri(uri)}
				onCloseSelf={() => closeDocumentByUri(uri)}
				onOpenSaved={(saved) => localSidebarBridge.openConnection(saved)}
			/>
		);
	}

	// Query document — payload carries the endpoint and the tab label.
	if (isQueryUri(uri)) {
		const doc = docs.getState().documents[uri];
		const payload = doc?.content as IQueryDocPayload | undefined;
		if (payload) {
			return (
				<QueryView
					key={uri}
					endpoint={payload.endpoint}
					label={payload.label}
					initialSql={payload.initialSql}
					origin={payload.origin}
				/>
			);
		}
	}

	// Table data-browser document — payload carries the endpoint and table.
	if (isTableDataUri(uri)) {
		const doc = docs.getState().documents[uri];
		const payload = doc?.content as { endpoint: ISqlEndpoint; table: string } | undefined;
		if (payload) return <TableDataView key={uri} endpoint={payload.endpoint} table={payload.table} />;
	}

	// Table-designer document — table null = create-table draft.
	if (isDesignUri(uri)) {
		const doc = docs.getState().documents[uri];
		const payload = doc?.content as { endpoint: ISqlEndpoint; table: string | null } | undefined;
		if (payload) return <TableDesignView key={uri} endpoint={payload.endpoint} table={payload.table} />;
	}

	// ER diagram document.
	if (isDiagramUri(uri)) {
		const doc = docs.getState().documents[uri];
		const endpoint = doc?.content as ISqlEndpoint | undefined;
		if (endpoint) return <DiagramView key={uri} endpoint={endpoint} />;
	}

	// Connection workbench document — the endpoint rides as the static
	// document's content payload.
	const key = endpointKeyFromUri(uri);
	if (key) {
		const doc = docs.getState().documents[uri];
		const endpoint = doc?.content as ISqlEndpoint | undefined;
		if (endpoint) return <ConnectionView key={key} endpoint={endpoint} />;
	}

	// Unknown scheme — should not happen; keep a visible trace for debugging.
	return <EmptyState title="Unknown document" description={uri} />;
};

export default SqlApp;
