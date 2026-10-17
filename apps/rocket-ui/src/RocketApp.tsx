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
import { useShellConnection, useAuthUser, useWorkspace, DocTabs, DocSplitLayout, AppLayout, ConfirmDialog } from 'shell';
import { AgentIcon } from './components/AgentIcon';
import type { SidebarViewContainer } from 'shell';
import { CodiconFiles, CodiconSourceControl, CodiconCircuitBoard, CodiconTypeHierarchy } from 'shared/components/icons/Codicon';
import { AppsIcon } from 'shared/components/icons/AppsIcon';
import { createDocs, destroyDocs, getDocs } from './docs';
import { createWorkspace, getWorkspace, resolveWorkspaceScope } from './workspace/workspace';
import { ModeSwitchBlockedError } from 'shared/workspace/commitPolicy';
import { createProjectVfs } from './utils/projectVfs';
import ProjectProvider from './providers/ProjectProvider';
import MonitorProvider from './providers/MonitorProvider';
import WebviewProvider from './providers/WebviewProvider';
import SidebarProvider from './providers/SidebarProvider';
import WorkspaceExplorerProvider from './providers/WorkspaceExplorerProvider';
import ScmProvider from './providers/ScmProvider';
import FileProvider from './providers/FileProvider';
import DiffProvider from './providers/DiffProvider';
import AppBuilderProvider from './providers/AppBuilderProvider';
import NewAppProvider from './providers/NewAppProvider';
import AgentProvider from './providers/AgentProvider';
import IntroProvider from './providers/IntroProvider';
import DesktopProvider from './providers/DesktopProvider';
import DevToolReadmeProvider from './providers/DevToolReadmeProvider';
import DevToolMount from './devtools/DevToolMount';
import { ToolGlyph } from './devtools/ToolGlyph';
import { useDevToolPins } from './devtools/devToolPins';
import { CodiconExtensions } from 'shared/components/icons/Codicon';
import { AgentSession } from 'shared/agent/agent';

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
	statusPending: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	statusAction: {
		background: 'none',
		border: '1px solid var(--rr-border-color)',
		borderRadius: 4,
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
		fontSize: 11.5,
		padding: '2px 8px',
	} as CSSProperties,
	statusError: {
		color: 'var(--rr-error-color, #d9534f)',
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
	const authUser = useAuthUser();
	const { loaded, appState, updateAppState, activeAppId, settings } = useWorkspace();
	const [ready, setReady] = useState(false);

	// --- Workspace scope (dev team → shared tree) -----------------------------

	// The storage scope: the account's development team (shared source tree)
	// when it validly names a team of the active org, else the user's own
	// store. The KEY is a bootstrap-effect dependency: a dev-team (or org)
	// change tears the whole document down — createWorkspace parks the
	// outgoing scope's unsaved buffers as staged layers and rebuilds against
	// the new tree, and Documents/sidebar remount on the fresh view.
	const workspaceScope = useMemo(() => resolveWorkspaceScope(authUser), [authUser]);
	const workspaceScopeKey = workspaceScope.kind === 'team' ? `team-${workspaceScope.teamId}` : 'user';

	// --- Workspace mode (autoCommit setting → CommitPolicy) -------------------

	// The autoCommit setting value; a ref carries the latest into the
	// bootstrap effect without retriggering it on every settings change.
	const settingAutoCommit = settings['rocketride.pipeBuilder.autoCommit'] !== false;
	const autoCommitRef = useRef(settingAutoCommit);
	autoCommitRef.current = settingAutoCommit;
	// True while the auto-commit switch is held up by pending staged
	// changes — drives the commit / discard / stay prompt below.
	const [modeSwitchBlocked, setModeSwitchBlocked] = useState(false);
	const [modeSwitchError, setModeSwitchError] = useState<string | null>(null);

	/**
	 * Resolves the blocked auto-commit switch: commit or discard everything
	 * pending, then enter auto mode. Conflicts (base changed since staging)
	 * block with nothing written and surface in the dialog.
	 */
	const resolveModeSwitch = useCallback(async (action: 'commit' | 'discard') => {
		const { policy } = getWorkspace();
		try {
			if (action === 'commit') {
				const result = await policy.commitAll();
				if (result.conflicts.length > 0) {
					setModeSwitchError(`${result.conflicts.length} file(s) changed on the server since they were staged — nothing was committed. Resolve them from the pending changes list first.`);
					return;
				}
			} else {
				await policy.discardAll();
			}
			policy.setMode(true);
			setModeSwitchBlocked(false);
			setModeSwitchError(null);
		} catch (err) {
			setModeSwitchError((err as Error).message);
		}
	}, []);

	// --- Pending-state surface (manual mode) -----------------------------------

	// Live count of staged-but-uncommitted changes; drives the status line.
	const [pendingCount, setPendingCount] = useState(0);
	const [pendingError, setPendingError] = useState<string | null>(null);
	// True while the status line's "Discard all" awaits its confirmation.
	const [discardConfirm, setDiscardConfirm] = useState(false);
	useEffect(() => {
		if (!ready) return;
		const view = getWorkspace().view;
		const update = () => setPendingCount(view.changedPaths().size);
		update();
		return view.subscribe(update);
	}, [ready]);

	/** Status line's "Commit all": one commit of everything pending. */
	const commitAllPending = useCallback(async () => {
		try {
			const result = await getWorkspace().policy.commitAll();
			setPendingError(result.conflicts.length > 0
				? `${result.conflicts.length} file(s) changed on the server since they were staged — nothing was committed.`
				: null);
		} catch (err) {
			setPendingError((err as Error).message);
		}
	}, []);

	/** Confirmed "Discard all": drops every staged layer, base untouched. */
	const discardAllPending = useCallback(async () => {
		setDiscardConfirm(false);
		try {
			await getWorkspace().policy.discardAll();
			setPendingError(null);
		} catch (err) {
			setPendingError((err as Error).message);
		}
	}, []);

	// The status-bar content: silent until something is pending, then it says
	// what the state means and offers the two ways out.
	const statusNode = useMemo(() => {
		if (!ready || pendingCount === 0) return undefined;
		return (
			<div style={styles.statusPending}>
				<span>
					{pendingCount} uncommitted change{pendingCount === 1 ? '' : 's'} — saved to your workspace, not yet committed to the server.
				</span>
				<button style={styles.statusAction} onClick={() => { void commitAllPending(); }}>Commit all</button>
				<button style={styles.statusAction} onClick={() => setDiscardConfirm(true)}>Discard all</button>
				{pendingError && <span style={styles.statusError}>{pendingError}</span>}
			</div>
		);
	}, [ready, pendingCount, pendingError, commitAllPending]);

	// --- Initialise workspace + Documents on mount ----------------------------

	useEffect(() => {
		// Wait until workspace is loaded from disk — loaded is only set true
		// after the disk read completes, never during pre-auth seeding.
		if (!client || !loaded) return;

		// The composition root runs FIRST: the staged workspace view (with
		// its persisted layers rehydrated and the real commit mode applied)
		// must exist before any consumer — Documents, sidebar, builders —
		// performs its first read. An unmount mid-build only flags
		// cancellation; the workspace itself lives for the document.
		let cancelled = false;
		void (async () => {
		const ws = await createWorkspace({ hostAppId: activeAppId, autoCommit: autoCommitRef.current, scope: workspaceScope });
		if (cancelled) return;
		// step: restored pending changes refuse auto mode — prompt the user
		if (ws.pendingBlocksAuto) setModeSwitchBlocked(true);

		/**
		 * Content adapter for pipeline documents: the shared project VFS
		 * (the staged workspace view's pipelines mount), with the Documents
		 * singleton's lenient error contract preserved — listing/read
		 * failures degrade to empty/null, save failures log and surface via
		 * the save paths that re-save explicitly. Routing through the VIEW
		 * is what makes staged (uncommitted) pipeline edits visible in tabs
		 * and keeps tab saves from clobbering staged layers.
		 */
		const projectVfs = createProjectVfs(client);
		const vfs: IVirtualFileSystem = {
			list: async (dir: string) => {
				try {
					return await projectVfs.list(dir);
				} catch {
					return [];
				}
			},
			read: async (uri: string) => {
				try {
					return await projectVfs.read(uri);
				} catch {
					return null;
				}
			},
			write: async (uri: string, content: unknown) => {
				if (!content) return;
				try {
					await projectVfs.write(uri, content);
				} catch (err) {
					console.error('[RocketApp] Failed to save:', err);
				}
			},
			rename: (oldPath: string, newPath: string) => projectVfs.rename(oldPath, newPath),
			delete: (path: string) => projectVfs.delete(path),
			mkdir: (path: string) => projectVfs.mkdir(path),
		};

		// Create the instance — both App and Sidebar will use it
		const docs = createDocs(vfs, { appState, updateAppState });

		// step: an empty restored workspace opens straight into a fresh Agent
		// conversation — the startup surface. Only when NO tabs were restored:
		// an existing session's tabs come back exactly as left.
		const restored = docs.getState();
		if (Object.keys(restored.editors).length === 0) {
			const session = AgentSession.newSession();
			docs.openStaticDocument(`agent:${session.sessionId}`, session.title);
		}

		setReady(true);
		})();

		return () => {
			cancelled = true;
			destroyDocs();
			setReady(false);
		};
		// workspaceScopeKey (not the scope object) keys the rebuild: the
		// bootstrap must re-run only when the scope MATERIALLY changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, loaded, activeAppId, workspaceScopeKey]);

	// --- Setting changes flow to the policy (the single mode owner) -----------

	useEffect(() => {
		if (!ready) return;
		try {
			getWorkspace().policy.setMode(settingAutoCommit);
			setModeSwitchBlocked(false);
		} catch (err) {
			// step: pending changes block manual -> auto; the prompt decides
			if (err instanceof ModeSwitchBlockedError) setModeSwitchBlocked(true);
			else throw err;
		}
	}, [settingAutoCommit, ready]);

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

	// Explorer and Source Control bring their OWN panel content (the raw
	// workspace tree and the pending-changes list); memoized once so a badge
	// update never remounts them (an element identity change would drop tree
	// expansion and scroll state).
	const explorerNode = useMemo(() => <WorkspaceExplorerProvider />, []);
	const scmNode = useMemo(() => <ScmProvider />, []);

	// The workbench rail containers, VS Code's order: Explorer first, then
	// Source Control, then this platform's modes. Agent carries isDefault —
	// rail POSITION and startup view are independent. The four mode
	// containers are deliberately WITHOUT content: they share the one
	// SidebarProvider node above, which mirrors the rail's selection through
	// useSidebarActiveView(), so there is exactly one data owner behind the
	// rail (one task monitor, one store scan) exactly as before. Icons are
	// VS Code's own (codicons) wherever an exact analogue exists; Agent
	// gets its own animated robot glyph — VS Code has no agent concept to
	// borrow from.
	// Pinned dev tools ride the SAME rail/strip as the built-in modes: one
	// container per pin (sharing the SidebarProvider node, which mounts the
	// tool's devToolSidebar behind its id), plus the Dev Tools catalog. The
	// persisted strip order (drag-reorder in classic mode) ranks the tool
	// containers here too, so the three chromes agree on one order.
	const { pinnedTools, tabOrder } = useDevToolPins();
	const sidebarViews = useMemo<SidebarViewContainer[]>(() => {
		const rank = new Map(tabOrder.map((id, i) => [id, i]));
		const toolViews = pinnedTools
			.slice()
			.sort((a, b) => (rank.get(`tool:${a.id}`) ?? Number.MAX_SAFE_INTEGER) - (rank.get(`tool:${b.id}`) ?? Number.MAX_SAFE_INTEGER))
			.map((t): SidebarViewContainer => ({ id: `tool:${t.id}`, title: t.name, icon: <ToolGlyph iconUrl={t.iconUrl} size={20} /> }));
		return [
			{ id: 'explorer', title: 'Explorer', icon: <CodiconFiles size={20} />, content: explorerNode },
			{ id: 'scm', title: 'Source Control', icon: <CodiconSourceControl size={20} />, content: scmNode, ...(pendingCount > 0 ? { badge: pendingCount } : {}) },
			{ id: 'agent', title: 'Agent', icon: <AgentIcon size={20} />, isDefault: true },
			{ id: 'apps', title: 'Apps', icon: <AppsIcon size={20} /> },
			{ id: 'nodes', title: 'Nodes', icon: <CodiconCircuitBoard size={20} /> },
			{ id: 'pipelines', title: 'Pipelines', icon: <CodiconTypeHierarchy size={20} /> },
			...toolViews,
			{ id: 'toolStore', title: 'Dev Tools', icon: <CodiconExtensions size={20} /> },
		];
	}, [explorerNode, scmNode, pendingCount, pinnedTools, tabOrder]);

	// The layout declaration: VS Code-style chrome (activity rail + panel) +
	// status bar. The sidebar only mounts once Documents is ready —
	// SidebarProvider shares the singleton with the editor surface. Below the
	// compact breakpoint the shell renders the classic drawer regardless of
	// mode, where SidebarProvider falls back to its own tab strip.
	if (!ready) return <AppLayout showStatus><div style={styles.welcome}>Initialising...</div></AppLayout>;
	return (
		<AppLayout sidebar={sidebar} sidebarMode="vscode" sidebarViews={sidebarViews} showStatus status={statusNode}>
			<RocketAppReady docs={getDocs()!} />
			{discardConfirm && (
				<ConfirmDialog
					title="Discard all pending changes"
					message={`Discard ${pendingCount} uncommitted change(s)? Your workspace returns to the last committed state; this cannot be undone.`}
					confirmLabel="Discard all"
					destructive
					onConfirm={() => { void discardAllPending(); }}
					onCancel={() => setDiscardConfirm(false)}
				/>
			)}
			{modeSwitchBlocked && (
				<ConfirmDialog
					title="Uncommitted changes"
					message={modeSwitchError ?? `Auto-commit is on, but ${getWorkspace().view.changedPaths().size} change(s) are still pending from manual mode. Commit them to the server (or discard them) to enter auto-commit, or stay in manual mode.`}
					confirmLabel="Commit all"
					secondaryLabel="Discard all"
					cancelLabel="Stay in manual"
					onConfirm={() => { void resolveModeSwitch('commit'); }}
					onSecondary={() => { void resolveModeSwitch('discard'); }}
					onCancel={() => { setModeSwitchBlocked(false); setModeSwitchError(null); }}
				/>
			)}
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
										<div style={{ fontSize: 16, fontWeight: 600 }}>Rocket Builder</div>
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
	if (uri === 'newapp') return <NewAppProvider />;
	// The shared desktop page (shell's DesktopView) as a document tab.
	if (uri === 'desktop') return <DesktopProvider />;
	// Agent conversation tabs carry only the session GUID in the URI — the
	// transcript lives in the fs store, never in workspace state.
	if (uri.startsWith('agent:')) return <AgentProvider sessionId={uri.slice('agent:'.length)} />;
	// Embedded "Introduction to ..." pages from the sidebar modes.
	if (uri.startsWith('intro:')) return <IntroProvider mode={uri.slice('intro:'.length)} />;
	// A pinned dev tool's main surface (descriptor.devToolFrame). The URI is
	// `tool:<appId>` for the tool's single frame, or `tool:<appId>/<docKey>`
	// for a per-document frame (e.g. one tab per database connection — the
	// tool opened it through DevToolProps.documents).
	if (uri.startsWith('tool:')) {
		const rest = uri.slice('tool:'.length);
		const slash = rest.indexOf('/');
		const appId = slash < 0 ? rest : rest.slice(0, slash);
		const docKey = slash < 0 ? undefined : rest.slice(slash + 1);
		return <DevToolMount appId={appId} slot="frame" {...(docKey !== undefined ? { docKey } : {})} />;
	}
	// A dev tool's details page (README + Install/Remove).
	if (uri.startsWith('toolreadme:')) return <DevToolReadmeProvider appId={uri.slice('toolreadme:'.length)} />;
	// Workspace Explorer's read-only text viewer for files with no designer.
	if (uri.startsWith('file:')) return <FileProvider path={uri.slice('file:'.length)} />;
	// Source Control's unified diff of one pending change.
	if (uri.startsWith('diff:')) return <DiffProvider path={uri.slice('diff:'.length)} />;
	// App Builder panels persist per-panel view state (the active stage)
	// through the editor's view-state row — the same channel the pipeline
	// editor uses — so two panels of one app restore independently.
	if (uri.startsWith('app:')) return <AppBuilderProvider uri={uri} {...(initialViewState ? { initialViewState } : {})} {...(onViewStateChange ? { onViewStateChange } : {})} />;
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
