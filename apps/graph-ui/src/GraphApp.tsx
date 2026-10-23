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
// GRAPH-UI - MAIN APP (document host: DocTabs + per-document views)
// =============================================================================
//
// An app-owned Documents instance renders DocTabs per editor group; this component
// routes each document URI to its view: the Connections landing, one workbench per
// connection, and (where the node allows execute) one write console per connection.
// Every document is static; the endpoint rides as its payload and carries no token.
//
// It also keeps the endpoint store wired to the platform (task events, focus, and a
// sign-out or change of user, organization or team forgetting every connection). With
// it, the app closes every workbench and write console and clears the schema snapshots,
// so one session's results and schema never show in the next.
//
// Every view reaches the engine and the stores through the GraphEnv (env.ts). This
// mount provides the LOCAL one (localEnv.ts) over the app's module-level stores, the
// realm's bus-backed client and the workspace prefs; the sidebar is rendered by the
// shell's chrome, outside this tree, so it gets its own provider.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { AppLayout, Button, ConnectionManager, DocSplitLayout, DocTabs, EmptyState, commonStyles, usePrefs, useShellConnection } from 'shell';
import type { Documents, ShellAppProps } from 'shell';
import { identityFingerprint, identityFromConnectResult } from 'shared/explorer';
import type { IExplorerEndpoint, IPrefsAccessor } from 'shared/explorer';
import { getBusExplorerClient } from 'shared/explorer/devtool/busClient';
import { activeConnection, appPreviews, dataVersions, graphEndpoints, graphHistory, schemas } from './adapters/explorer';
import { GraphHistoryPrefsBridge, useEndpointStoreLifecycle } from './adapters/react';
import { APP_HISTORY_PRIVACY_NOTE, GraphEnvProvider, useGraphEndpoints } from './env';
import type { DocTarget } from './env';
import { createLocalGraphEnv } from './localEnv';
import type { IGraphStores } from './localEnv';
import { CONNECTIONS_URI, endpointKeyFromUri, isWorkbenchUri, isWriteUri, workbenchUri, writeUri } from './graph/addresses';
import { createDocs, destroyDocs, getDocs } from './docs';
import { forgetConnections } from './graph/identityChange';
import type { IConnectionDocPayload } from './docs';
import GraphSidebar from './GraphSidebar';
import RealmLiveRegion from './components/RealmLiveRegion';
import { GraphIcon } from './icons';
import ConnectionsView from './views/ConnectionsView';
import WorkbenchView from './views/WorkbenchView';
import WriteConsoleView from './views/WriteConsoleView';

const styles = {
	container: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' } as CSSProperties,
	groupPane: { ...commonStyles.columnFill, minWidth: 0, overflow: 'hidden' } as CSSProperties,
	content: { flex: 1, display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' } as CSSProperties,
	editorPane: (active: boolean): CSSProperties => ({ display: active ? 'flex' : 'none', flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column' }),
	welcome: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' } as CSSProperties,
};

/** The full app's stores: the adapter's module-level instances. */
const APP_STORES: IGraphStores = { endpoints: graphEndpoints, schemas, dataVersions, history: graphHistory, previews: appPreviews };

/**
 * Open a document of the full app.
 *
 * @param target - What to open.
 */
function openAppDocument(target: DocTarget): void {
	const docs = getDocs();
	if (!docs) return;
	if (target.kind === 'connections') docs.openStaticDocument(CONNECTIONS_URI, 'Connections');
	else if (target.kind === 'workbench') docs.openStaticDocument(workbenchUri(target.endpoint.key), target.endpoint.nodeName || 'Graph', { endpoint: target.endpoint });
	else docs.openStaticDocument(writeUri(target.endpoint.key), `${target.endpoint.nodeName || 'Graph'} (write)`, { endpoint: target.endpoint });
}

/**
 * Workspace prefs with one stable identity: the shell hands out a new accessor whenever any preference changes, and
 * the views need one object for the mount's life. {@link AppPrefsBinding} keeps it pointed at the latest.
 *
 * @returns The accessor and its binder.
 */
function forwardingPrefs(): IPrefsAccessor & { bind(api: IPrefsAccessor): void } {
	let current: IPrefsAccessor | null = null;
	return {
		bind: (api) => {
			current = api;
		},
		getPref: (key) => current?.getPref(key),
		setPref: (key, value) => current?.setPref(key, value),
	};
}

/** Binds the full app's workspace prefs (a leaf, so a preference change re-renders nothing else). Full app only. */
const AppPrefsBinding: React.FC<{ prefs: ReturnType<typeof forwardingPrefs> }> = ({ prefs }) => {
	prefs.bind(usePrefs());
	return null;
};

/**
 * Graph Explorer - client area.
 *
 * @param props - Shell-injected props: connection state and the signed-in identity.
 * @returns The app.
 */
const GraphApp: React.FC<ShellAppProps> = ({ identity }) => {
	const [ready, setReady] = useState(false);
	const { isConnected } = useShellConnection();
	// The realm's bus-backed client (one per realm): in the shell `client.*` runs in this realm, codes intact.
	const client = useMemo(() => (isConnected ? getBusExplorerClient(ConnectionManager.getInstance()) : null), [isConnected]);
	useEndpointStoreLifecycle(graphEndpoints, client, identity);
	const [prefs] = useState(forwardingPrefs);
	const env = useMemo(
		() => createLocalGraphEnv({ mount: 'app', ready: isConnected, client, stores: APP_STORES, activeConnection, openDocument: openAppDocument, prefs, historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE }),
		[isConnected, client, prefs]
	);

	// A different user, organization or team (or a sign-out) must find nothing from before: no schema, and no
	// workbench or write console still showing the previous identity's results (the store forgets its endpoints).
	// On the first run the documents do not exist yet, so only the schema snapshots are cleared.
	const fingerprint = identityFingerprint(identityFromConnectResult(identity));
	useEffect(() => {
		forgetConnections(getDocs(), { schemas });
	}, [fingerprint]);

	useEffect(() => {
		const docs = createDocs();
		docs.openStaticDocument(CONNECTIONS_URI, 'Connections');
		setReady(true);
		return () => {
			destroyDocs();
			setReady(false);
		};
	}, []);

	// The shell renders the sidebar in its own chrome, outside this tree: it gets its own provider, re-registered only
	// when the env changes.
	const sidebar = useMemo(() => <GraphEnvProvider value={env}><GraphSidebar /></GraphEnvProvider>, [env]);

	if (!ready) return <AppLayout showStatus><AppPrefsBinding prefs={prefs} /></AppLayout>;
	return (
		<GraphEnvProvider value={env}>
			<AppPrefsBinding prefs={prefs} />
			<AppLayout sidebar={sidebar} showStatus>
				<GraphAppReady docs={getDocs()!} />
			</AppLayout>
		</GraphEnvProvider>
	);
};

/**
 * Renders once Documents is ready (so its store hook is called unconditionally).
 *
 * @param props.docs - The app's Documents instance.
 * @returns The tab groups and the active documents.
 */
const GraphAppReady: React.FC<{ docs: Documents }> = ({ docs }) => {
	const state = docs.useStore();

	// Publish the active connection (the sidebar's schema follows it), for any connection-scoped document.
	useEffect(() => {
		const group = state.groups[state.activeGroupId];
		const editorId = group?.editorIds[group.activeEditorIndex];
		const editor = editorId ? state.editors[editorId] : undefined;
		activeConnection.set(editor ? endpointKeyFromUri(editor.documentUri) : null);
	}, [state]);

	const canCloseGroups = state.rootNode.type === 'split';

	return (
		<div style={styles.container}>
			{/* One polite live region for the whole realm (dev-tool documents may share it); every announcement goes through it. */}
			<RealmLiveRegion />
			{/* History only records while a bridge is mounted; this one is app-level so a run in a tab whose connection page was closed still records. */}
			<GraphHistoryPrefsBridge />
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;
					return (
						<div style={styles.groupPane} onClick={() => docs.setActiveGroup(groupId)}>
							<DocTabs docs={docs} groupId={groupId} isActive={state.activeGroupId === groupId} canClose={canCloseGroups} onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)} onCloseGroup={(gid) => { void docs.requestCloseGroup(gid); }} />
							{/* All editors stay mounted and visibility toggles, so a tab keeps its editor text, results and graph. */}
							<div style={styles.content}>
								{group.editorIds.length === 0 ? (
									<div style={styles.welcome}>
										<EmptyState
											icon={<GraphIcon />}
											title="Graph Explorer"
											description="Open Connections to browse the graph databases reachable through your pipelines."
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
										return (
											<div key={editorId} style={styles.editorPane(idx === group.activeEditorIndex)}>
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

/**
 * The live endpoint for a document: the store's current record when it has one
 * (so a restarted pipeline shows its new state), else what the tab was opened with,
 * marked stopped when a successful discovery no longer lists it.
 *
 * @param opened - The endpoint the tab was opened with.
 * @returns The endpoint to show.
 */
function useLiveEndpoint(opened: IExplorerEndpoint): IExplorerEndpoint {
	const { status, endpoints } = useGraphEndpoints();
	const live = endpoints.find((e) => e.key === opened.key);
	if (live) return live;
	if (status === 'ready') return { ...opened, state: 'stopped', stateDetail: 'This pipeline is no longer running. Start it, then refresh the connections.' };
	return opened;
}

/** A workbench or write console, bound to the live endpoint. */
const ConnectionDocument: React.FC<{ opened: IExplorerEndpoint; write: boolean }> = ({ opened, write }) => {
	const endpoint = useLiveEndpoint(opened);
	return write ? <WriteConsoleView endpoint={endpoint} /> : <WorkbenchView endpoint={endpoint} />;
};

/**
 * Renders the view for one document URI.
 *
 * @param props.uri - The document URI.
 * @param props.docs - The app's Documents instance (content lookup).
 * @returns The view.
 */
const DocumentPane: React.FC<{ uri: string; docs: Documents }> = ({ uri, docs }) => {
	if (uri === CONNECTIONS_URI) return <ConnectionsView />;
	if (isWorkbenchUri(uri) || isWriteUri(uri)) {
		const payload = docs.getState().documents[uri]?.content as IConnectionDocPayload | undefined;
		if (payload?.endpoint) return <ConnectionDocument key={uri} opened={payload.endpoint} write={isWriteUri(uri)} />;
	}
	return <EmptyState title="Unknown document" description={uri} />;
};

export default GraphApp;
