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
// VECTOR-UI - MAIN APP (document host: DocTabs + per-document views)
// =============================================================================
//
// An app-owned Documents instance renders DocTabs per editor group; this
// component routes each document URI to its view: the Connections landing,
// one console per connection (its default document; the Map is a tab inside
// it), and one tab per opened stored document. Every document is static; the
// endpoint rides as its payload and carries no token.
//
// It also keeps the endpoint store wired to the platform (task events, focus,
// identity), and on a sign-out or a change of user, organization or team it
// closes every console and document tab and clears every per-connection
// cache, so nothing of one identity's stores shows in the next.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { AppLayout, Button, DocSplitLayout, DocTabs, EmptyState, commonStyles, useShellConnection } from 'shell';
import type { Documents, ShellAppProps } from 'shell';
import { identityFingerprint, identityFromConnectResult } from 'shared/explorer';
import { makeConsoleActions } from './adapters/consoleActions';
import { appConnections } from './adapters/connections';
import { activeConnection, announcer, connectionCaches, vectorEndpoints } from './adapters/explorer';
import { VectorHistoryPrefsBridge, useEndpointStoreLifecycle } from './adapters/react';
import RealmLiveRegion from './components/RealmLiveRegion';
import RemoveDialogHost from './components/RemoveDialogHost';
import { createDocs, destroyDocs, getDocs, openDocumentTab } from './docs';
import type { IConsoleDocPayload, IDocumentDocPayload } from './docs';
import { VectorEnvProvider, useConnection, useLiveEndpoint } from './envContext';
import { createLocalVectorEnv } from './localEnv';
import { CONNECTIONS_URI, endpointKeyFromUri, isConsoleUri, isDocumentUri } from './vector/addresses';
import { forgetConnections } from './vector/identityChange';
import VectorSidebar from './VectorSidebar';
import { VectorIcon } from './icons';
import ConnectionsView, { openConsole } from './views/ConnectionsView';
import ConsoleView from './views/ConsoleView';
import DocumentView from './views/DocumentView';

const styles = {
	container: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' } as CSSProperties,
	groupPane: { ...commonStyles.columnFill, minWidth: 0, overflow: 'hidden' } as CSSProperties,
	content: { flex: 1, display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' } as CSSProperties,
	editorPane: (active: boolean): CSSProperties => ({ display: active ? 'flex' : 'none', flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column' }),
	welcome: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' } as CSSProperties,
};

/** The landing document's URI and label. */
const LANDING = { uri: CONNECTIONS_URI, label: 'Connections' };

/** The active connection, as the env hands it out. */
const ACTIVE = { get: activeConnection.get, subscribe: activeConnection.subscribe };

/**
 * Vector Explorer - client area.
 *
 * @param props - Shell-injected props: connection state and the signed-in identity.
 * @returns The app.
 */
const VectorApp: React.FC<ShellAppProps> = ({ identity }) => {
	const [ready, setReady] = useState(false);
	const { client, isConnected } = useShellConnection();
	useEndpointStoreLifecycle(vectorEndpoints, client, identity);
	// The LOCAL env every view below reads: the app's store, its client, its connection registry and its documents.
	const env = useMemo(() => createLocalVectorEnv({ ready: client !== null && isConnected, client, store: vectorEndpoints, registry: appConnections, activeConnection: ACTIVE, openConsole, openDocument: openDocumentTab }), [client, isConnected]);

	// A different user, organization or team (or a sign-out) must find nothing from before: every console and
	// document tab closes and every per-connection cache clears. On the first run the documents do not exist yet.
	const fingerprint = identityFingerprint(identityFromConnectResult(identity));
	useEffect(() => {
		forgetConnections(getDocs(), connectionCaches, endpointKeyFromUri, LANDING);
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

	// The sidebar takes no props and reads shared stores, so its slot registration is stable.
	const sidebar = useMemo(() => <VectorSidebar />, []);

	if (!ready) return <AppLayout showStatus>{null}</AppLayout>;
	return (
		<AppLayout sidebar={sidebar} showStatus>
			<VectorEnvProvider value={env}>
				<VectorAppReady docs={getDocs()!} />
			</VectorEnvProvider>
		</AppLayout>
	);
};

/**
 * Renders once Documents is ready (so its store hook is called unconditionally).
 *
 * @param props.docs - The app's Documents instance.
 * @returns The tab groups and the active documents.
 */
const VectorAppReady: React.FC<{ docs: Documents }> = ({ docs }) => {
	const state = docs.useStore();

	// Publish the active connection (the sidebar and the remove dialog follow it), for any connection-scoped document.
	useEffect(() => {
		const group = state.groups[state.activeGroupId];
		const editorId = group?.editorIds[group.activeEditorIndex];
		const editor = editorId ? state.editors[editorId] : undefined;
		activeConnection.set(editor ? endpointKeyFromUri(editor.documentUri) : null);
	}, [state]);

	const canCloseGroups = state.rootNode.type === 'split';

	return (
		<div style={styles.container}>
			{/* One polite live region for the whole realm (rocket-ui may run dev-tool documents beside the app); every announcement goes through it. */}
			<RealmLiveRegion />
			{/* Chat history only records while a bridge is mounted; app-level so it survives closing a console. */}
			<VectorHistoryPrefsBridge />
			{/* Removal is confirmed here, outside every pane, so the dialog is visible wherever it was asked for. */}
			<RemoveDialogHost />
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;
					return (
						<div style={styles.groupPane} onClick={() => docs.setActiveGroup(groupId)}>
							<DocTabs docs={docs} groupId={groupId} isActive={state.activeGroupId === groupId} canClose={canCloseGroups} onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)} onCloseGroup={(gid) => docs.closeGroup(gid)} />
							{/* All editors stay mounted and visibility toggles, so a tab keeps its directory, chat and map. */}
							<div style={styles.content}>
								{group.editorIds.length === 0 ? (
									<div style={styles.welcome}>
										<EmptyState
											icon={<VectorIcon />}
											title="Vector Explorer"
											description="Open Connections to see the vector stores reachable through your pipelines."
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
										const active = idx === group.activeEditorIndex;
										return (
											<div key={editorId} style={styles.editorPane(active)}>
												<DocumentPane uri={editor.documentUri} docs={docs} active={active} />
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

/** One stored document's tab, bound to its connection's live model. */
const DocumentTab: React.FC<{ payload: IDocumentDocPayload; active: boolean }> = ({ payload, active }) => {
	const endpoint = useLiveEndpoint(payload.endpoint);
	const { entry, model, channels } = useConnection(endpoint);
	const actions = useMemo(
		() =>
			makeConsoleActions(entry, {
				openDocument: (objectId, chunkId) => openDocumentTab(entry.ctx.endpoint, objectId, objectId === payload.objectId ? payload.path : null, chunkId),
				// "Show chunk path on map", a chunk's "map" and "Ask about" land on the console, in front of this tab.
				showConsole: () => openConsole(entry.ctx.endpoint),
				announce: (text) => announcer.announce(text),
			}),
		[entry, payload.objectId, payload.path]
	);
	// Removing from a document tab needs the console's write switch.
	useEffect(() => {
		entry.controller.setWritesEnabled(model.writes.enabled);
	}, [model.writes.enabled, entry]);
	return <DocumentView model={model} channels={channels} selection={entry.selection} actions={actions} objectId={payload.objectId} path={payload.path} active={active} {...(payload.chunkId === undefined ? {} : { chunkId: payload.chunkId })} />;
};

/**
 * Renders the view for one document URI.
 *
 * @param props.uri - The document URI.
 * @param props.docs - The app's Documents instance (content lookup).
 * @param props.active - Whether the tab is the active one of its group.
 * @returns The view.
 */
const DocumentPane: React.FC<{ uri: string; docs: Documents; active: boolean }> = ({ uri, docs, active }) => {
	if (uri === CONNECTIONS_URI) return <ConnectionsView />;
	const content = docs.getState().documents[uri]?.content;
	if (isConsoleUri(uri)) {
		const payload = content as IConsoleDocPayload | undefined;
		if (payload?.endpoint) return <ConsoleView key={uri} opened={payload.endpoint} active={active} />;
	}
	if (isDocumentUri(uri)) {
		const payload = content as IDocumentDocPayload | undefined;
		if (payload?.endpoint && payload.objectId) return <DocumentTab key={uri} payload={payload} active={active} />;
	}
	return <EmptyState title="Unknown document" description={uri} />;
};

export default VectorApp;
