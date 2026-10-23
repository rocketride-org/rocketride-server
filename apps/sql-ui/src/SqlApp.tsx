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

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell';
import { ConnectionManager, DocTabs, DocSplitLayout, AppLayout, usePrefs, useShellConnection } from 'shell';
import type { Documents } from 'shell';
import { EmptyState } from 'shell';
import { commonStyles } from 'shell';
import { closeDocumentByUri, connectionEditorIdFromUri, createDocs, destroyDocs, endpointKeyFromAnyUri, endpointKeyFromUri, getDocs, isConnectionEditorUri, isDesignUri, isDiagramUri, isQueryUri, isTableDataUri } from './docs';
import type { QueryDocPayload } from './docs';
import { setActiveConnection } from './navigation';
import { resetSavedConnections, isDirectEndpointKey } from './connect';
import { directReleasesOnClose } from './directReleases';
import { createLocalSidebarBridge, createLocalSqlEnv } from './localEnv';
import type { SqlSidebarBridge } from './sidebarBridge';
import { createSqlCore } from './sqlCore';
import type { SqlCore } from './sqlCore';
import { SQL_APP_ID } from './appId';
import { sqlIdentityScope } from './identityScope';
import { SqlEnvProvider, useSqlEnv } from './sqlEnv';
import type { SqlEndpoint } from './connect';
import ConnectionView from './views/ConnectionView';
import ConnectionOverlays from './components/ConnectionOverlays';
import ConnectionEditorBody from './components/ConnectionEditorBody';
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
// (QueryDocPayload); producers and this consumer import it from there.

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
 * A provider's display title from the shell's cached service list (no
 * request: the summary the shell already fetched).
 *
 * @param provider - The provider id.
 * @returns The title, when the cache has one.
 */
function serviceTitle(provider: string): string | undefined {
	const { services } = ConnectionManager.getInstance().getCachedServices();
	const entry = services[provider] as { title?: string } | undefined;
	return entry?.title;
}

/**
 * SQL Explorer — client area. Initialises the app-owned Documents instance
 * (all documents are static), auto-opens the Connections landing document,
 * and renders the DocTabs + editor-group layout.
 *
 * @param _props - Shell-injected props (unused; connection comes from hooks).
 */
const SqlApp: React.FC<ShellAppProps> = (_props) => {
	const { isConnected } = useShellConnection();
	const [ready, setReady] = useState(false);

	// The full app's engine core (sqlCore.ts): the shared endpoint store, its
	// sessions, the identity it discovers for, and the saved-connection list,
	// which it reads from the user's store for each signed-in identity.
	const [core, setCore] = useState<SqlCore | null>(null);
	useEffect(() => {
		const created = createSqlCore({ cm: ConnectionManager.getInstance(), appId: SQL_APP_ID, mode: 'app' });
		setCore(created);
		return () => created.dispose();
	}, []);

	// A different user, organization or team closes the previous account's
	// tabs and schema; an identity nobody can vouch for (signed out, dropped)
	// forgets the schema (identityScope.ts, R9). A layout effect, so a render
	// after the change is never painted with the old results.
	useLayoutEffect(() => {
		if (!core) return undefined;
		sqlIdentityScope.apply(core.identity.get().known ? core.identity.fingerprint : null);
		return core.identity.subscribe((snapshot) => {
			sqlIdentityScope.apply(snapshot.known ? snapshot.fingerprint : null);
		});
	}, [core]);

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

	// The shell's workspace preferences, behind a stable accessor: the full
	// app keeps history (HistoryPrefsBridge below) and the pattern-check switch
	// there. Dev-tool mounts never call usePrefs.
	const shellPrefs = usePrefs();
	const prefsRef = useRef(shellPrefs);
	prefsRef.current = shellPrefs;
	const prefs = useMemo(() => ({
		getPref: (key: string) => prefsRef.current.getPref(key),
		setPref: (key: string, value: unknown) => prefsRef.current.setPref(key, value),
	}), []);

	// The in-document sidebar bridge over the core (one per core).
	const localBridge = useMemo(() => (core ? createLocalSidebarBridge(core) : null), [core]);

	// Sidebar node memoized per bridge: SqlSidebar reads the rest of its state
	// from the shared singletons, so the slot registration is stable.
	const sidebar = useMemo(() => (localBridge ? <SqlSidebar bridge={localBridge} /> : null), [localBridge]);

	// The FULL APP's engine surface: the realm legitimately owns a connection,
	// so the views get the LOCAL environment (dev-tool frames get the remote one).
	const env = useMemo(() => (core ? createLocalSqlEnv(core, isConnected, serviceTitle, prefs) : null), [core, isConnected, prefs]);

	// Two-column app: the navigation/schema sidebar mounts once Documents is
	// ready (it shares the singleton with the workbench documents).
	if (!ready || !env || !localBridge) return <AppLayout showStatus>{null}</AppLayout>;
	return (
		<SqlEnvProvider value={env}>
			<AppLayout sidebar={sidebar} showStatus>
				<SqlAppReady docs={getDocs()!} bridge={localBridge} />
				{/* Sidebar-requested dialogs render HERE, outside the sidebar
				    subtree — the compact drawer is a transformed ancestor that
				    would trap a fixed-position overlay. */}
				<ConnectionOverlays />
			</AppLayout>
		</SqlEnvProvider>
	);
};

/**
 * Inner component that renders once Documents is ready.
 * Separated so useStore() is called unconditionally.
 */
const SqlAppReady: React.FC<{ docs: Documents; bridge: SqlSidebarBridge }> = ({ docs, bridge }) => {
	const state = docs.useStore();
	const env = useSqlEnv();

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
	// diagram), stop its temporary tool pipeline. Grouped by connection
	// (directReleases.ts): an edit changes the key without re-keying open
	// documents, so the last one to close releases UNKEYED. The 15-minute
	// idle TTL is the backstop for everything this cannot see (reloads,
	// crashes).
	const openDirectKeysRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const open = new Set<string>();
		for (const editor of Object.values(state.editors)) {
			const key = endpointKeyFromAnyUri(editor.documentUri);
			if (key && isDirectEndpointKey(key)) open.add(key);
		}
		for (const release of directReleasesOnClose(openDirectKeysRef.current, open)) env.releaseEndpoint(release.connId, release.key);
		openDirectKeysRef.current = open;
	}, [state, env]);

	// Multiple groups exist — show the close-group affordance on tabs.
	const canCloseGroups = state.rootNode.type === 'split';

	return (
		<div style={styles.container}>
			{/* The realm's one polite live region (shared with any dev-tool frames); announce() writes to it. */}
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
								onCloseGroup={(gid) => { void docs.requestCloseGroup(gid); }}
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
												<DocumentPane uri={editor.documentUri} docs={docs} bridge={bridge} />
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
 * @param props.bridge - The full app's sidebar bridge (opens a newly saved connection).
 */
const DocumentPane: React.FC<{ uri: string; docs: Documents; bridge: SqlSidebarBridge }> = ({ uri, docs, bridge }) => {
	// Connection editor document (add/edit form as a top-level tab).
	if (isConnectionEditorUri(uri)) {
		return (
			<ConnectionEditorBody
				key={uri}
				connId={connectionEditorIdFromUri(uri)}
				onCloseSelf={() => closeDocumentByUri(uri)}
				onOpenSaved={(saved) => bridge.openConnection(saved)}
			/>
		);
	}

	// Query document — payload carries the endpoint and the tab label.
	if (isQueryUri(uri)) {
		const doc = docs.getState().documents[uri];
		const payload = doc?.content as QueryDocPayload | undefined;
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
		const payload = doc?.content as { endpoint: SqlEndpoint; table: string } | undefined;
		if (payload) return <TableDataView key={uri} endpoint={payload.endpoint} table={payload.table} />;
	}

	// Table-designer document — table null = create-table draft.
	if (isDesignUri(uri)) {
		const doc = docs.getState().documents[uri];
		const payload = doc?.content as { endpoint: SqlEndpoint; table: string | null } | undefined;
		if (payload) return <TableDesignView key={uri} endpoint={payload.endpoint} table={payload.table} />;
	}

	// ER diagram document.
	if (isDiagramUri(uri)) {
		const doc = docs.getState().documents[uri];
		const endpoint = doc?.content as SqlEndpoint | undefined;
		if (endpoint) return <DiagramView key={uri} endpoint={endpoint} />;
	}

	// Connection workbench document — the endpoint rides as the static
	// document's content payload.
	const key = endpointKeyFromUri(uri);
	if (key) {
		const doc = docs.getState().documents[uri];
		const endpoint = doc?.content as SqlEndpoint | undefined;
		if (endpoint) return <ConnectionView key={key} endpoint={endpoint} />;
	}

	// Unknown scheme — should not happen; keep a visible trace for debugging.
	return <EmptyState title="Unknown document" description={uri} />;
};

export default SqlApp;
