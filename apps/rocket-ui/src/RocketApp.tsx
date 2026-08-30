// MIT License
//
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
// ROCKET APP — top-level component mounted by the shell
// =============================================================================
//
// Initialises the Documents singleton with a content adapter for pipeline
// files, renders DocTabs per editor group, and routes document content to
// the appropriate view component (ProjectProvider, MonitorProvider).
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell';
import type { IVirtualFileSystem } from 'shell';
import { commonStyles } from 'shell';
import { useShellConnection, useWorkspace, DocTabs, DocSplitLayout, AppLayout } from 'shell';
import { createDocs, destroyDocs, getDocs } from './docs';
import { loadProject, saveProject, listProjectDir, renameProject, deleteProject, mkdirProject } from './utils/projectStore';
import ProjectProvider from './providers/ProjectProvider';
import MonitorProvider from './providers/MonitorProvider';
import WebviewProvider from './providers/WebviewProvider';
import SidebarProvider from './providers/SidebarProvider';

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
	content: {
		flex: 1,
		display: 'flex',
		minHeight: 0,
		// minWidth 0 kills flex's min-width:auto so this row always fits the
		// available width instead of the widest descendant (a Chart.js canvas
		// carries an explicit pixel width, which otherwise ratchets the whole
		// editor pane wider than the viewport).
		minWidth: 0,
		overflow: 'hidden',
	} as CSSProperties,
	welcome: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 14,
		flexDirection: 'column',
		gap: 12,
	} as CSSProperties,
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Top-level RocketRide app component mounted by the shell.
 *
 * Initialises the Documents singleton with a content adapter that reads/writes
 * pipeline files via the RocketRide client's project store.  Both this
 * component and SidebarProvider share the same Documents singleton.
 *
 * @param _props - Shell-injected props (isConnected, identity).
 */
const RocketApp: React.FC<ShellAppProps> = (_props) => {
	const { client } = useShellConnection();
	const { loaded, appState, updateAppState } = useWorkspace();
	const [ready, setReady] = useState(false);

	// --- Initialise Documents on mount ---------------------------------------

	useEffect(() => {
		// Wait until workspace is loaded from disk — loaded is only set true
		// after the disk read completes, never during pre-auth seeding.
		if (!client || !loaded) return;

		/**
		 * Content adapter that reads/writes pipeline JSON files via the
		 * RocketRide client's project store API.
		 */
		const vfs: IVirtualFileSystem = {
			list: async (dir: string) => {
				if (!client) return [];
				try {
					const result = await listProjectDir(client, dir);
					return (result.entries ?? []).map((e: any) => ({ name: e.name, type: e.type ?? 'file' }));
				} catch {
					return [];
				}
			},
			read: async (uri: string) => {
				if (!client) return null;
				try {
					return await loadProject(client, uri);
				} catch {
					return null;
				}
			},
			write: async (uri: string, content: unknown) => {
				if (!client || !content) return;
				try {
					await saveProject(client, uri, content);
				} catch (err) {
					console.error('[RocketApp] Failed to save:', err);
				}
			},
			rename: async (oldPath: string, newPath: string) => {
				if (!client) return;
				await renameProject(client, oldPath, newPath);
			},
			delete: async (path: string) => {
				if (!client) return;
				await deleteProject(client, path);
			},
			mkdir: async (path: string) => {
				if (!client) return;
				await mkdirProject(client, path);
			},
		};

		// Create the instance — both App and Sidebar will use it
		createDocs(vfs, { appState, updateAppState });
		setReady(true);

		return () => {
			destroyDocs();
			setReady(false);
		};
	}, [client, loaded]);

	// --- Sign-out -------------------------------------------------------------
	// Logout is handled entirely by the shell, in-place: handleLogout switches the
	// active app back to home and calls cm.logout(), which clears the token and
	// disconnects — and disconnect() detaches the persist:true client (desired
	// state → "detached", reconnect timer cleared) so it can NOT silently
	// reconnect. We deliberately do NOT hard-reload here: a window.location
	// navigation would abort the shell's clean transition to the logged-out home
	// and re-enter the auth bootstrap, bouncing the user to the Zitadel login.

	// Sidebar node memoized once: SidebarProvider takes no props and reads all
	// its state from the shared singletons, so the slot registration is stable.
	const sidebar = useMemo(() => <SidebarProvider />, []);

	// The layout declaration: two columns (pipelines Explorer) + status bar.
	// The sidebar only mounts once Documents is ready — SidebarProvider shares
	// the singleton with the editor surface.
	if (!ready)
		return (
			<AppLayout showStatus>
				<div style={styles.welcome}>Initialising...</div>
			</AppLayout>
		);
	return (
		<AppLayout sidebar={sidebar} showStatus>
			<RocketAppReady docs={getDocs()!} />
		</AppLayout>
	);
};

/**
 * Inner component that renders once Documents is ready.
 * Separated so useStore() hook is called unconditionally.
 */
const RocketAppReady: React.FC<{ docs: import('shell').Documents }> = ({ docs }) => {
	const state = docs.useStore();

	// --- Ctrl+S handler -------------------------------------------------------

	useEffect(() => {
		/**
		 * Listens for the shell's tab:save custom event and saves the active
		 * document.  Reads state at call time via getDocumentsState().
		 */
		const handler = () => {
			const s = docs.getState();
			const group = s.groups[s.activeGroupId];
			if (!group) return;
			const editorId = group.editorIds[group.activeEditorIndex];
			if (!editorId) return;
			const editor = s.editors[editorId];
			if (!editor) return;
			docs.saveDocument(editor.documentUri);
		};
		window.addEventListener('tab:save', handler);
		return () => window.removeEventListener('tab:save', handler);
	}, []);

	// --- Split keyboard shortcuts ---------------------------------------------

	useEffect(() => {
		/**
		 * Handles split keyboard shortcuts:
		 *   Ctrl+\        — split right with current document
		 *   Ctrl+Shift+\  — split down with current document
		 */
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
				e.preventDefault();
				const s = docs.getState();
				const orientation = e.shiftKey ? 'vertical' : 'horizontal';
				docs.splitGroupWithDocument(s.activeGroupId, orientation);
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);

	// --- Derived state --------------------------------------------------------

	/** Whether there are multiple groups (controls close-group button visibility). */
	const canCloseGroups = state.rootNode.type === 'split';

	// --- Render editor groups layout ------------------------------------------

	return (
		<div style={styles.container}>
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;

					return (
						<div style={styles.groupPane} onClick={() => docs.setActiveGroup(groupId)}>
							{/* Tab bar for this group */}
							<DocTabs docs={docs} groupId={groupId} isActive={state.activeGroupId === groupId} canClose={canCloseGroups} onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)} onCloseGroup={(gid) => docs.closeGroup(gid)} />

							{/* Editor content — keep all editors mounted, toggle visibility.
							    This preserves per-view state (chat history, dropper rows,
							    trace events) across tab switches.  Each editor unmounts only
							    when its tab is closed. */}
							<div style={styles.content}>
								{group.editorIds.length === 0 ? (
									<div style={styles.welcome}>
										<div style={{ fontSize: 16, fontWeight: 600 }}>Pipeline Builder</div>
										<div>Open a project from the Explorer or create a new one to get started.</div>
									</div>
								) : (
									group.editorIds.map((editorId, idx) => {
										const editor = state.editors[editorId];
										if (!editor) return null;
										const isActive = idx === group.activeEditorIndex;
										return (
											<div
												key={editorId}
												style={{
													display: isActive ? 'flex' : 'none',
													flex: 1,
													minHeight: 0,
													// Flex item in the content row: without minWidth 0
													// its min-width:auto = the widest descendant (the
													// status chart's canvas), so the pane refuses to
													// shrink to the available width and the right side
													// clips off-screen.
													minWidth: 0,
													flexDirection: 'column',
												}}
											>
												<GroupEditorPane uri={editor.documentUri} editorId={editorId} />
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
// GROUP EDITOR PANE — subscribes to a single document
// =============================================================================

/**
 * Renders the editor content for a single document URI.  Uses useDocument()
 * to subscribe only to changes in THIS document, not the entire state.
 * This prevents ReactFlow re-renders when unrelated documents change.
 *
 * @param props.uri      - The document URI to render.
 * @param props.editorId - The editor instance ID for per-view state tracking.
 */
const GroupEditorPane: React.FC<{ uri: string; editorId: string }> = ({ uri, editorId }) => {
	const d = getDocs();
	const state = d!.useStore();
	const doc = state.documents[uri];

	// Freeze the initial view state at mount time — it's initial state, not
	// live state.  Live changes are persisted via onViewStateChange and will
	// be picked up on the next mount (e.g. after F5).
	const initialViewStateRef = useRef(state.editors[editorId]?.viewState);

	/**
	 * Updates document content when the pipeline editor reports a change.
	 */
	const handleContentChanged = useCallback((changedUri: string, payload: any) => {
		getDocs()?.updateContent(changedUri, payload);
	}, []);

	/**
	 * Persists view state (active tab, viewport) back to the editor instance.
	 */
	const handleViewStateChange = useCallback(
		(viewState: Record<string, unknown>) => {
			getDocs()?.updateEditorViewState(editorId, viewState);
		},
		[editorId]
	);

	if (!doc) return null;

	return <RocketEditorContent uri={doc.uri} content={doc.content} dirty={doc.dirty} isNew={doc.isNew} {...(initialViewStateRef.current ? { initialViewState: initialViewStateRef.current } : {})} onContentChanged={handleContentChanged} onViewStateChange={handleViewStateChange} />;
};

// =============================================================================
// EDITOR CONTENT ROUTER
// =============================================================================

/**
 * Routes document content to the appropriate view component based on the
 * file URI pattern.
 *
 * @param props.uri                - The document URI / file path.
 * @param props.content            - The raw document content (JSON string for pipelines).
 * @param props.dirty              - Whether the document has unsaved changes.
 * @param props.isNew              - Whether the document has never been saved.
 * @param props.initialViewState   - Per-editor saved view state (tab, viewport).
 * @param props.onContentChanged   - Called when the editor modifies the content.
 * @param props.onViewStateChange  - Called when view state changes (tab, viewport).
 */
const RocketEditorContent: React.FC<{
	uri: string;
	content: unknown;
	dirty: boolean;
	isNew: boolean;
	initialViewState?: Record<string, unknown>;
	onContentChanged: (uri: string, payload: any) => void;
	onViewStateChange?: (viewState: Record<string, unknown>) => void;
}> = ({ uri, content, dirty, isNew, initialViewState, onContentChanged, onViewStateChange }) => {
	// Stable per-uri content handler. An inline arrow here would hand
	// ProjectProvider (and ultimately <ReactFlow>) a new onContentChanged every
	// render, churning every derived node/edge handler and looping StoreUpdater
	// ("Maximum update depth exceeded").
	const handleProjectContentChanged = useCallback((updatedPipeline: any) => onContentChanged(uri, updatedPipeline), [onContentChanged, uri]);

	// Static document routes — not backed by VFS
	if (uri === 'monitor') return <MonitorProvider />;
	if (uri.startsWith('webview:')) return <WebviewProvider uri={uri} />;

	// Content is the pipeline object directly — no parsing needed
	const pipeline = content as any;

	if (!pipeline) {
		return (
			<div style={styles.welcome}>
				<div>No content: {uri}</div>
			</div>
		);
	}

	// status: URIs are read-only views for running tasks with no local .pipe file
	const isReadonly = uri.startsWith('status:');

	// Route pipeline files to ProjectProvider
	return <ProjectProvider uri={uri} pipeline={pipeline} isDirty={dirty} isNew={isNew} isReadonly={isReadonly} {...(initialViewState ? { initialViewState } : {})} onContentChanged={handleProjectContentChanged} {...(onViewStateChange ? { onViewStateChange } : {})} />;
};

export default RocketApp;
