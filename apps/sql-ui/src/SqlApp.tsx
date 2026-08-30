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
// document URI to its view — the Connections landing doc plus one workbench
// doc per open connection (query/designer/diagram docs join in later phases).
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell';
import { DocTabs, DocSplitLayout, AppLayout } from 'shell';
import type { Documents } from 'shell';
import { Button, EmptyState } from 'shell';
import { commonStyles } from 'shell';
import { CONNECTIONS_URI, createDocs, destroyDocs, endpointKeyFromAnyUri, endpointKeyFromUri, getDocs, isDesignUri, isDiagramUri, isQueryUri, isTableDataUri } from './docs';
import { setActiveConnection } from './navigation';
import type { ISqlEndpoint } from './connect';
import ConnectionsView from './views/ConnectionsView';
import ConnectionView from './views/ConnectionView';
import QueryView from './views/QueryView';
import TableDataView from './views/TableDataView';
import TableDesignView from './views/TableDesignView';
import DiagramView from './views/DiagramView';
import SqlSidebar from './SqlSidebar';
import { DatabaseIcon } from './icons';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		display: 'flex',
		flexDirection: 'column',
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
	const [ready, setReady] = useState(false);

	// Create the Documents instance once; the landing doc opens with it.
	useEffect(() => {
		const docs = createDocs();
		docs.openStaticDocument(CONNECTIONS_URI, 'Connections');
		setReady(true);
		return () => {
			destroyDocs();
			setReady(false);
		};
	}, []);

	// Sidebar node memoized once: SqlSidebar takes no props and reads all its
	// state from the shared singletons, so the slot registration is stable.
	const sidebar = useMemo(() => <SqlSidebar />, []);

	// Two-column app: the navigation/schema sidebar mounts once Documents is
	// ready (it shares the singleton with the workbench documents).
	if (!ready) return <AppLayout showStatus>{null}</AppLayout>;
	return (
		<AppLayout sidebar={sidebar} showStatus>
			<SqlAppReady docs={getDocs()!} />
		</AppLayout>
	);
};

/**
 * Inner component that renders once Documents is ready.
 * Separated so useStore() is called unconditionally.
 */
const SqlAppReady: React.FC<{ docs: Documents }> = ({ docs }) => {
	const state = docs.useStore();

	// Publish the active connection (for the sidebar's schema tree): the
	// active group's active editor, for ANY connection-scoped document —
	// query/table/design/diagram tabs must keep the tree bound too.
	useEffect(() => {
		const group = state.groups[state.activeGroupId];
		const editorId = group?.editorIds[group.activeEditorIndex];
		const editor = editorId ? state.editors[editorId] : undefined;
		setActiveConnection(editor ? endpointKeyFromAnyUri(editor.documentUri) : null);
	}, [state]);

	// Multiple groups exist — show the close-group affordance on tabs.
	const canCloseGroups = state.rootNode.type === 'split';

	return (
		<div style={styles.container}>
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;

					return (
						<div style={styles.groupPane} onClick={() => docs.setActiveGroup(groupId)}>
							{/* Tab bar for this group. */}
							<DocTabs docs={docs} groupId={groupId} isActive={state.activeGroupId === groupId} canClose={canCloseGroups} onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)} onCloseGroup={(gid) => docs.closeGroup(gid)} />

							{/* Editor content — all editors stay mounted; visibility
							    toggles so per-view state survives tab switches. */}
							<div style={styles.content}>
								{group.editorIds.length === 0 ? (
									<div style={styles.welcome}>
										<EmptyState
											icon={<DatabaseIcon />}
											title="SQL Explorer"
											description="Open the Connections view to browse the databases reachable through your pipelines."
											action={
												<Button variant="primary" onClick={() => docs.openStaticDocument(CONNECTIONS_URI, 'Connections')}>
													Open Connections
												</Button>
											}
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
	// Connections landing document.
	if (uri === CONNECTIONS_URI) return <ConnectionsView />;

	// Query document — payload carries the endpoint and the tab label.
	if (isQueryUri(uri)) {
		const doc = docs.getState().documents[uri];
		const payload = doc?.content as { endpoint: ISqlEndpoint; label: string } | undefined;
		if (payload) return <QueryView key={uri} endpoint={payload.endpoint} label={payload.label} />;
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
