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
// ROCKET SIDEBAR — pipelines Explorer, the app's AppLayout sidebar node
// =============================================================================
//
// Renders the pipelines sidebar — the Explorer file tree plus the
// running/other-task section — as the node RocketApp passes to its root
// <AppLayout sidebar={...}>, composing with the shell's fixed header/footer.
// State comes from the shared Documents singleton and the shell connection,
// so the sidebar and the editor surface are one program.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShellConnection, ConnectionManager, ConfirmDialog, useWorkspace } from 'shell';
import type { ShellNotification } from 'shell';
import { getDocs } from '../docs';
import { SidebarChrome } from 'shared/tools/core/chrome/SidebarChrome';
import { buildBuiltinSidebarItems } from './sidebarBuiltinTools';
import { BxExport, useSidebarCollapsed, useSidebarActiveView } from 'shell';
import { foldTaskEvent } from 'shared/modules/sidebar/taskFold';
import type { ProjectEntry, ActiveTaskState, UnknownTask, ConnectionInfo, SidebarMode, AgentSidebar, AppBuilderSidebar, AppListItem, ToolTabsSidebar } from 'shared/modules/sidebar/types';
import { useDevToolPins, toToolTab } from '../devtools/devToolPins';
import { setToolFrameOpener } from '../devtools/peer';
import DevToolMount from '../devtools/DevToolMount';
import type { TaskLifecycleEvent } from 'shared/modules/sidebar/taskFold';
import { AgentSession, AGENTS_DIR } from 'shared/agent/agent';
import type { AgentSessionMeta } from 'shared/agent/agent';
import { isPipelineFile, pipelineExtension } from '../utils/projectStore';
import { createProjectVfs } from '../utils/projectVfs';
import { getWorkspaceVfs, storePathToVirtual } from '../workspace/workspace';
import { downloadJson } from '../utils/downloadFile';
import { scanApps } from '../appdev/appStore';
import { INTRO_PAGES } from 'shared/modules/intro/introPages';
import type { IntroMode } from 'shared/modules/intro/introPages';

// =============================================================================
// COLLAPSED GATE
// =============================================================================

/**
 * Collapse gate for the registered Explorer content. The shell renders
 * registered sidebar content even while the sidebar is collapsed to its icon
 * rail; this free-form Explorer content has no icon-rail form (a future
 * per-app design task), so the gate reads the shell-provided collapsed flag
 * and renders nothing while collapsed — preserving the previous
 * hide-when-collapsed look. The confirm/error dialogs mount OUTSIDE this gate
 * so they stay up (and their promises resolve) across a collapse.
 */
const SidebarCollapsedGate: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Collapsed flag provided by the shell around the sidebar slot.
	const collapsed = useSidebarCollapsed();
	return collapsed ? null : <>{children}</>;
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * RocketRide sidebar container.
 *
 * Uses shared's SidebarView which internally composes the Explorer
 * file tree component.  Builds pipeline-specific data (entries with
 * sources, active tasks) and provides callbacks for all actions, and
 * renders the resulting node — RocketApp passes this component as its
 * AppLayout `sidebar` prop. A SidebarCollapsedGate hides the Explorer
 * while the sidebar is collapsed; the confirm/error dialogs sit outside
 * the gate so they persist across a collapse.
 */
const SidebarProvider: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	// The pipelines mount of the shared staged view, project-relative — the
	// ONE adapter every pipeline file operation goes through.
	const projectVfs = useMemo(() => createProjectVfs(client), [client]);

	// --- Build entries from server file tree ----------------------------------

	const [entries, setEntries] = useState<ProjectEntry[]>([]);
	const refreshCountRef = useRef(0);

	// Confirmation dialog — resolve ref avoids state-update cascades
	const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);
	const [confirmState, setConfirmState] = useState<{
		title: string;
		message: string;
		confirmLabel: string;
	} | null>(null);

	/** Show a confirm dialog and return a promise that resolves to true/false. */
	const showConfirm = useCallback((title: string, message: string, confirmLabel = 'Delete'): Promise<boolean> => {
		return new Promise((resolve) => {
			confirmResolveRef.current = resolve;
			setConfirmState({ title, message, confirmLabel });
		});
	}, []);

	/** Dismiss the dialog and resolve the promise. */
	const handleConfirmResult = useCallback((confirmed: boolean) => {
		setConfirmState(null);
		// Resolve after state update via microtask to avoid mid-render cascades
		const resolve = confirmResolveRef.current;
		confirmResolveRef.current = null;
		if (resolve) queueMicrotask(() => resolve(confirmed));
	}, []);

	/**
	 * Recursively lists .pipe files from the server and parses each one
	 * to extract projectId and source components.
	 */
	const refresh = useCallback(async () => {
		if (!client || !isConnected) {
			setEntries([]);
			return;
		}
		const id = ++refreshCountRef.current;

		try {
			// Recursive list — through the workspace VIEW, so staged
			// (uncommitted) pipelines list exactly like committed ones.
			const view = getWorkspaceVfs();
			const listRecursive = async (dir: string): Promise<ProjectEntry[]> => {
				const result = { entries: await view.list(dir ? `pipelines/${dir}` : 'pipelines') };
				const out: ProjectEntry[] = [];
				for (const e of result.entries ?? []) {
					// Dot-directories at the store root are OTHER surfaces'
					// trees (.appdev working copies) — never pipeline content.
					if (!dir && e.type === 'dir' && e.name.startsWith('.')) continue;
					const path = dir ? `${dir}/${e.name}` : e.name;
					if (e.type === 'dir') {
						out.push({ path, type: 'dir' });
						out.push(...(await listRecursive(path)));
					} else if (isPipelineFile(e.name)) {
						// Parse pipeline for projectId + sources
						try {
							const pipeline = JSON.parse(String(await view.read(`pipelines/${path}`)));
							out.push({
								path,
								type: 'file',
								projectId: pipeline?.project_id,
								sources: (pipeline?.components ?? []).filter((c: any) => c.type === 'source').map((c: any) => ({ id: c.id, name: c.name ?? c.id, provider: c.provider })),
							});
						} catch {
							out.push({ path, type: 'file' });
						}
					}
				}
				return out;
			};

			const all = await listRecursive('');
			// Only update if this is still the latest refresh
			if (id === refreshCountRef.current) setEntries(all);
		} catch {
			if (id === refreshCountRef.current) setEntries([]);
		}
	}, [client, isConnected]);

	// Refresh on connect and on project:saved events
	useEffect(() => {
		refresh();
	}, [refresh]);
	useEffect(() => {
		const handler = () => refresh();
		window.addEventListener('project:saved', handler);
		return () => window.removeEventListener('project:saved', handler);
	}, [refresh]);
	// Staged workspace ticks (agent writes, commits, rollbacks) re-list too
	useEffect(() => getWorkspaceVfs().subscribe(() => refresh()), [refresh]);

	// --- Active tasks (from server events) -----------------------------------

	const [activeTasks, setActiveTasks] = useState<Map<string, ActiveTaskState>>(new Map());
	const [unknownTasks, setUnknownTasks] = useState<UnknownTask[]>([]);

	// Synchronously-updated mirrors: the shared foldTaskEvent needs BOTH
	// collections atomically, and websocket events can burst faster than a
	// render — refs are advanced in the handler itself so successive folds
	// never read stale state. The effects below re-anchor them whenever any
	// OTHER mutation site (disconnect reset, entries re-filter) lands.
	const activeTasksRef = useRef(activeTasks);
	const unknownTasksRef = useRef(unknownTasks);
	useEffect(() => {
		activeTasksRef.current = activeTasks;
	}, [activeTasks]);
	useEffect(() => {
		unknownTasksRef.current = unknownTasks;
	}, [unknownTasks]);

	// Keep a ref to entries so event handlers can check known tasks without
	// re-registering the effect on every entries change
	const entriesRef = useRef(entries);
	useEffect(() => {
		entriesRef.current = entries;
		// Re-evaluate unknown tasks — some may now match newly-parsed entries
		setUnknownTasks((prev) => prev.filter((ut) => !entries.some((e) => (!e.type || e.type === 'file') && e.projectId === ut.projectId && e.sources?.some((s: { id: string }) => s.id === ut.sourceId))));
	}, [entries]);

	/** Check if a projectId+sourceId matches any known local pipeline file. */
	const isKnownTask = useCallback((projectId: string, sourceId: string): boolean => {
		return entriesRef.current.some((e) => (!e.type || e.type === 'file' ? e.projectId === projectId && e.sources?.some((s: { id: string }) => s.id === sourceId) : false));
	}, []);

	useEffect(() => {
		if (!client || !isConnected) {
			setActiveTasks(new Map());
			setUnknownTasks([]);
			return;
		}

		// Subscribe to server-side task lifecycle events so the server routes
		// apaevt_task / apaevt_status_update to this connection.
		// When TASK is first enabled the server immediately pushes an
		// apaevt_task with action:'running' containing all active tasks.
		client.addMonitor({ token: '*' }, ['task', 'output']).catch((err) => {
			console.error('[SidebarProvider] Failed to subscribe to task events:', err);
		});

		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: { event: any }) => {
			if (event?.event === 'apaevt_task') {
				const body = event.body as TaskLifecycleEvent | undefined;
				if (!body) return;

				// The dev-view classification and the whole lifecycle fold live
				// in shared code (foldTaskEvent) — one implementation for this
				// host and the VS Code sidebar. Deploy runs never enter the
				// active/ad-hoc lists; the fold filters every path.
				const folded = foldTaskEvent(body, activeTasksRef.current, unknownTasksRef.current, isKnownTask);
				if (folded) {
					activeTasksRef.current = folded.activeTasks;
					unknownTasksRef.current = folded.unknownTasks;
					setActiveTasks(folded.activeTasks);
					setUnknownTasks(folded.unknownTasks);
				}
			} else if (event?.event === 'apaevt_status_update') {
				// Incremental status update: merge errors/warnings into existing task.
				// Deploy runs never touch the dev lists (same classification as
				// the fold) — their status belongs to the deployment surfaces.
				const body = event.body;
				if (!body?.project_id || !body?.source) return;
				if (body.runKind === 'deploy') return;
				const key = `${body.project_id}.${body.source}`;
				setActiveTasks((prev) => {
					const next = new Map(prev);
					const existing = next.get(key) ?? { running: false, errors: [], warnings: [] };
					next.set(key, { ...existing, errors: body.errors ?? [], warnings: body.warnings ?? [] });
					return next;
				});
			}
		});

		return () => {
			unsub();
			client.removeMonitor({ token: '*' }, ['task', 'output']).catch(() => {});
		};
	}, [client, isConnected, isKnownTask]);

	// --- Connection info -----------------------------------------------------

	const connection: ConnectionInfo = useMemo(
		() => ({
			state: isConnected ? 'connected' : 'disconnected',
		}),
		[isConnected]
	);

	// --- Active file path (highlights the currently open file in sidebar) ----
	// getDocs() may be null on the first render before RocketApp creates it.
	// Subscribe to Documents state changes so the highlight updates when the
	// user switches editor tabs.

	const [activeFilePath, setActiveFilePath] = useState('');
	useEffect(() => {
		const docs = getDocs();
		if (!docs) return;
		/** Reads the active editor's documentUri from the Documents state. */
		const readActive = (): string => {
			const s = docs.getState();
			const group = s.groups[s.activeGroupId];
			if (!group) return '';
			const editorId = group.editorIds[group.activeEditorIndex];
			return editorId ? (s.editors[editorId]?.documentUri ?? '') : '';
		};
		setActiveFilePath(readActive());
		return docs.subscribe(() => setActiveFilePath(readActive()));
	}, []);

	// --- Callbacks -----------------------------------------------------------

	/**
	 * Handles navigation button clicks.
	 */
	const handleNavigate = useCallback((target: string) => {
		// getDocs() is null until RocketApp creates the Documents singleton.
		const docs = getDocs();
		if (!docs) return;
		if (target === 'new') {
			docs.createDocument(undefined, { project_id: crypto.randomUUID(), components: [] });
		}
	}, []);

	/**
	 * Opens a file in the Documents singleton.
	 */
	const handleOpenFile = useCallback((path: string) => {
		getDocs()?.openDocument(path);
	}, []);

	/**
	 * Handles file management actions via the RocketRide client.
	 */
	const handleFileManage = useCallback(
		async (action: 'rename' | 'delete' | 'createFolder' | 'createFile', path: string, newName?: string) => {
			if (!client) return;
			try {
				switch (action) {
					case 'rename': {
						// `newName` is a bare leaf (e.g. "renamed"); construct a full path
						// that preserves the parent dir and whichever pipeline extension
						// the file carried (directories carry none).
						if (!newName) break;
						const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
						const ext = pipelineExtension(path);
						const newPath = dir ? `${dir}/${newName}${ext}` : `${newName}${ext}`;
						if (newPath !== path) {
							await projectVfs.rename(path, newPath);
							// Update open editor tabs: close old, reopen at new path
							const docs = getDocs();
							if (docs) {
								const st = docs.getState();
								const editorIds = Object.entries(st.editors)
									.filter(([, ed]) => ed.documentUri === path)
									.map(([id]) => id);
								for (const eid of editorIds) docs.closeEditor(eid);
								if (editorIds.length > 0) await docs.openDocument(newPath);
							}
						}
						break;
					}
					case 'delete': {
						// Confirm before deleting
						const label = path.split('/').pop() ?? path;
						const confirmed = await showConfirm('Delete', `Are you sure you want to delete "${label}"?`, 'Delete');
						if (!confirmed) break;

						// The view routes by actual kind (files delete, folders
						// remove recursively) — one verb covers both.
						await projectVfs.delete(path);

						// Force-remove the document and all editors regardless of dirty state
						// so stale content doesn't linger if a new file reuses the same name
						getDocs()?.discardDocument(path);
						break;
					}
					case 'createFolder':
						await projectVfs.mkdir(path);
						break;
					case 'createFile':
						await projectVfs.write(path, { project_id: crypto.randomUUID(), components: [] });
						break;
				}
				refresh();
			} catch (err) {
				// Constant format string (SAST rule): the action rides as an arg.
				console.error('[SidebarProvider] action failed:', action, err);
			}
		},
		[client, refresh, projectVfs]
	);

	/**
	 * Exports a pipeline as a downloaded .pipe file. SaaS-only — injected into
	 * the Explorer kebab via `fileActions`; the VS Code host omits it.
	 */
	const handleExportPipeline = useCallback(
		async (path: string) => {
			if (!client) return;
			try {
				// Through the view: an export of a staged (uncommitted)
				// pipeline downloads what the user SEES, not the server copy.
				const pipeline = await projectVfs.read(path);
				const filename = path.split('/').pop() ?? 'pipeline.pipe';
				downloadJson(filename, pipeline);
			} catch (err) {
				console.error('[SidebarProvider] export failed:', err);
			}
		},
		[client, projectVfs]
	);

	// Action error state — shown as a dialog when run/stop fails
	const [actionError, setActionError] = useState<string | null>(null);

	/**
	 * Handles run/stop actions on source components.
	 */
	const handleSourceAction = useCallback(
		async (action: 'run' | 'stop', filePath: string, sourceId: string, projectId?: string) => {
			if (!client || !isConnected) return;
			if (action === 'run' && filePath) {
				try {
					// D1: a run executes what is SAVED to the workspace (staged
					// included) — the view, not necessarily the server copy.
					const pipeline = JSON.parse(String(await projectVfs.read(filePath)));
					const name =
						filePath
							.split('/')
							.pop()
							?.replace(/\.pipe$/, '') ?? filePath;
					await client.use({ pipeline, source: sourceId, name, pipelineTraceLevel: 'full' });
				} catch (err) {
					setActionError(err instanceof Error ? err.message : String(err));
				}
			} else if (action === 'stop' && projectId) {
				try {
					const token = await client.getTaskToken({ projectId, source: sourceId });
					if (token) await client.terminate(token);
				} catch (err) {
					setActionError(err instanceof Error ? err.message : String(err));
				}
			}
		},
		[client, isConnected]
	);

	/**
	 * Opens a read-only status view for a task that has no local .pipe file.
	 * Fetches the real pipeline config from the running task so the designer
	 * renders the full component graph (same approach as VS Code's StatusProvider).
	 */
	const handleOpenUnknownTask = useCallback(
		async (projectId: string, sourceId: string, displayName: string) => {
			const docs = getDocs();
			if (!docs || !client) return;

			const uri = `status:${projectId}.${sourceId}`;

			// Fetch the real pipeline from the running task
			let pipeline: any;
			try {
				const token = await client.getTaskToken({ projectId, source: sourceId });
				if (token) pipeline = await client.getTaskPipeline(token);
			} catch {
				// Fetch failed — fall back to a minimal stub
			}
			if (!pipeline) {
				pipeline = {
					project_id: projectId,
					components: [{ id: sourceId, name: displayName, provider: 'unknown', config: { mode: 'Source', name: displayName } }],
				};
			}

			// Open as a static (read-only) document
			docs.openStaticDocument(uri, displayName, pipeline);
		},
		[client]
	);

	// --- App Builder (MY APPS) -----------------------------------------------

	// The MY APPS list from the .appdev store scan — the web twin of the
	// VSCode workspace scan (working copies only; no registry state).
	const [apps, setApps] = useState<AppListItem[]>([]);
	// step: every refresh takes a ticket — a slow scan that resolves after a
	// disconnect or after a NEWER refresh must not land its stale rows
	const appsReqRef = useRef(0);
	const refreshApps = useCallback(async () => {
		const req = ++appsReqRef.current;
		if (!client || !isConnected) {
			setApps([]);
			return;
		}
		try {
			const scanned = await scanApps();
			if (req !== appsReqRef.current) return;
			setApps(scanned.map((a) => ({ id: a.id, name: a.name })));
		} catch {
			if (req === appsReqRef.current) setApps([]);
		}
	}, [client, isConnected]);
	useEffect(() => {
		void refreshApps();
	}, [refreshApps]);

	// The App Builder sidebar contract: presence adds the Apps mode tab.
	const appBuilder: AppBuilderSidebar = useMemo(
		() => ({
			apps,
			// The open App Builder document is `app:<appId>`.
			activeAppId: activeFilePath.startsWith('app:') ? activeFilePath.slice('app:'.length) : undefined,
			onNewApp: () => {
				getDocs()?.openStaticDocument('newapp', 'New App');
			},
			onOpenApp: (appId: string) => {
				const name = apps.find((a) => a.id === appId)?.name ?? appId;
				getDocs()?.openStaticDocument(`app:${appId}`, name);
			},
		}),
		[apps, activeFilePath]
	);

	// --- Agent (MY SESSIONS) ---------------------------------------------------

	// The agent's session HISTORY is namespaced by this hosting app's id —
	// the workspace supplies it (never hardcoded); AgentSession.configure
	// stamps it once for the shared storage layer. Sessions themselves are
	// operationally unrestricted (any app/node/pipeline).
	const { activeAppId: hostAppId, prefs, updatePrefs } = useWorkspace();
	useEffect(() => {
		AgentSession.configure(hostAppId);
	}, [hostAppId]);

	// The MY SESSIONS list from the .agents catalog.
	const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
	// step: same ticket guard as refreshApps — only the newest listing lands
	const sessionsReqRef = useRef(0);
	const refreshSessions = useCallback(async () => {
		const req = ++sessionsReqRef.current;
		if (!client || !isConnected) {
			setSessions([]);
			return;
		}
		try {
			const listed = await AgentSession.getSessions();
			if (req !== sessionsReqRef.current) return;
			setSessions(listed);
		} catch {
			if (req === sessionsReqRef.current) setSessions([]);
		}
	}, [client, isConnected]);
	useEffect(() => {
		void refreshSessions();
	}, [refreshSessions]);

	// Two change sources serve the list refreshes: the workspace view's
	// change stream covers in-page writes (staged ones included — those
	// never reach the server, so no bus event exists for them), and the
	// shell bus covers CROSS-page writers, translated once by the workspace
	// module. Agent history is a separate store tree (not a workspace
	// mount), so it stays bus-only.
	useEffect(() => {
		const unsubView = getWorkspaceVfs().subscribe(() => void refreshApps());
		const unsubBus = ConnectionManager.getInstance().on('shell:notify', (notification: ShellNotification) => {
			if (notification.kind !== 'onFsChange') return;
			if (storePathToVirtual(notification.uri)?.startsWith('apps')) void refreshApps();
			else if (notification.uri.startsWith(`${AGENTS_DIR}/${hostAppId}/`)) void refreshSessions();
		});
		return () => {
			unsubView();
			unsubBus();
		};
	}, [refreshApps, refreshSessions, hostAppId]);

	// The Agent sidebar contract: presence adds the Agent mode tab.
	const agent: AgentSidebar = useMemo(
		() => ({
			sessions,
			// The open conversation document is `agent:<sessionId>`.
			activeSessionId: activeFilePath.startsWith('agent:') ? activeFilePath.slice('agent:'.length) : undefined,
			onNewSession: () => {
				// step: mint the GUID now; nothing hits disk until the first send
				const session = AgentSession.newSession();
				getDocs()?.openStaticDocument(`agent:${session.sessionId}`, session.title);
			},
			onOpenSession: (sessionId: string) => {
				const title = sessions.find((s) => s.sessionId === sessionId)?.title ?? 'Agent session';
				getDocs()?.openStaticDocument(`agent:${sessionId}`, title);
			},
			onDeleteSession: (sessionId: string) => {
				void (async () => {
					const title = sessions.find((s) => s.sessionId === sessionId)?.title ?? sessionId;
					const confirmed = await showConfirm('Delete session', `Are you sure you want to delete "${title}"?`, 'Delete');
					if (!confirmed) return;
					await AgentSession.deleteSession(sessionId);
					// Force-close the conversation tab regardless of state.
					getDocs()?.discardDocument(`agent:${sessionId}`);
				})();
			},
		}),
		[sessions, activeFilePath, showConfirm]
	);

	// --- Dev tools (pinned tool tabs + catalog) --------------------------------

	// Pins, strip order, and the server's devTool catalog — prefs-backed, one
	// source of truth shared with RocketApp's rail containers.
	const { tabOrder, catalog: toolCatalog, pinnedTools, unpin: unpinTool, setTabOrder } = useDevToolPins();

	/** Opens (or focuses) a tool's frame as a `tool:<appId>` document. */
	const handleOpenTool = useCallback((id: string) => {
		const name = toolCatalog.find((a) => a.id === id)?.name ?? id;
		getDocs()?.openStaticDocument(`tool:${id}`, name);
	}, [toolCatalog]);

	/** Strip tab selection: bring an OPEN document of the tool forward —
	 *  never create one; selecting a sidebar tab must not spawn tabs. */
	const handleFocusTool = useCallback((id: string) => {
		const docs = getDocs();
		if (!docs) return;
		const state = docs.getState();
		for (const [groupId, group] of Object.entries(state.groups)) {
			for (let i = 0; i < group.editorIds.length; i++) {
				const editorId = group.editorIds[i];
				const uri = editorId ? state.editors[editorId]?.documentUri : undefined;
				if (uri === `tool:${id}` || uri?.startsWith(`tool:${id}/`)) {
					docs.setActiveGroup(groupId);
					docs.setActiveEditor(groupId, i);
					return;
				}
			}
		}
	}, []);

	// A sidebar-mount peer post with no mounted frame summons the tool's
	// document (the in-memory counterpart of the bridge's onPanelNeeded).
	useEffect(() => {
		setToolFrameOpener(handleOpenTool);
		return () => setToolFrameOpener(null);
	}, [handleOpenTool]);

	// The dev-tool tabs contract: presence adds the pinned tool tabs and the
	// Dev Tools catalog tab to the mode strip (classic mode); the workbench
	// rail mirrors the same pins through RocketApp's sidebarViews.
	const toolTabs: ToolTabsSidebar = useMemo(() => ({
		tools: pinnedTools,
		available: toolCatalog.map(toToolTab),
		onOpenTool: handleOpenTool,
		onFocusTool: handleFocusTool,
		onShowTool: (id: string) => {
			const name = toolCatalog.find((a) => a.id === id)?.name ?? id;
			getDocs()?.openStaticDocument(`toolreadme:${id}`, `Dev Tool: ${name}`);
		},
		onRemoveTool: (id: string) => {
			// A removed tool keeps no live surface — close its open frame and
			// every per-document tab it opened (`tool:<id>/<docKey>`).
			unpinTool(id);
			const docs = getDocs();
			if (!docs) return;
			for (const uri of Object.keys(docs.getState().documents)) {
				if (uri === `tool:${id}` || uri.startsWith(`tool:${id}/`)) docs.discardDocument(uri);
			}
		},
		renderToolPanel: (id: string) => <DevToolMount appId={id} name={pinnedTools.find((t) => t.id === id)?.name ?? id} slot="sidebar" />,
	}), [pinnedTools, toolCatalog, handleOpenTool, handleFocusTool, unpinTool]);

	/** Opens a mode's embedded "Introduction to ..." page as a document tab. */
	const handleShowIntro = useCallback((mode: IntroMode) => {
		getDocs()?.openStaticDocument(`intro:${mode}`, INTRO_PAGES[mode].title);
	}, []);

	/** Opens the shared Desktop page (shell's DesktopView) as a document tab. */
	const handleShowDesktop = useCallback(() => {
		getDocs()?.openStaticDocument('desktop', 'Desktop');
	}, []);

	// --- Render ----------------------------------------------------------------

	// Mode tab selection (Agent | Apps | Nodes | Pipelines) — prefs-backed so
	// the choice survives reload via workspace state. Agent is the startup
	// default when no stored choice exists (requirement: default tab unless
	// workspace state says otherwise).
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => (prefs?.sidebarMode as SidebarMode | undefined) ?? 'agent');
	const handleSidebarModeChange = useCallback(
		(mode: SidebarMode) => {
			setSidebarMode(mode);
			updatePrefs({ sidebarMode: mode });
		},
		[updatePrefs]
	);

	// The shell workbench rail (AppLayout sidebarMode 'vscode'/'cursor') owns
	// the mode selection when it encloses this content: mirror its active
	// view and hide the in-panel strip — one switcher on screen. Null outside
	// a workbench (classic sidebar, compact drawer), where the strip and the
	// prefs-backed state behave exactly as before.
	const shellView = useSidebarActiveView();
	/** Narrows a rail container id to the SidebarView mode union. */
	const isKnownMode = (id: string | undefined): id is SidebarMode =>
		id === 'agent' || id === 'apps' || id === 'nodes' || id === 'pipelines' || id === 'toolStore' || !!id?.startsWith('tool:');
	const effectiveMode = shellView && isKnownMode(shellView.activeViewId) ? shellView.activeViewId : sidebarMode;

	// Rail → frame: SELECTING a tool's rail/strip container opens its document
	// (the classic strip gets this from SidebarView's own tab handler; the
	// workbench rail only reports the selection). Transitions only — a page
	// boot restoring a remembered tool selection must not force the document
	// open.
	const prevShellViewRef = useRef<string | undefined>(shellView?.activeViewId);
	useEffect(() => {
		const id = shellView?.activeViewId;
		const prev = prevShellViewRef.current;
		prevShellViewRef.current = id;
		if (id && id !== prev && prev !== undefined && id.startsWith('tool:')) handleOpenTool(id.slice('tool:'.length));
	}, [shellView?.activeViewId, handleOpenTool]);

	// Frame → rail: focusing a tool's document highlights its rail container
	// (the VS Code host's onPanelFocused → setModeExternal, in-tree). The
	// container id is the tool, so a per-document URI (`tool:<appId>/<docKey>`)
	// maps back to its tool's container.
	useEffect(() => {
		if (!shellView || !activeFilePath.startsWith('tool:')) return;
		const containerId = `tool:${activeFilePath.slice('tool:'.length).split('/')[0]}`;
		if (shellView.activeViewId !== containerId) shellView.setActiveView(containerId);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- sync on document focus changes only
	}, [activeFilePath]);

	// The sidebar node — the pipelines Explorer plus its confirm/error dialogs.
	// Only the Explorer sits behind the collapse gate: the shell frame owns the
	// collapse behaviour and hides free-form content while the sidebar is
	// collapsed, so no collapsed icon rail is drawn here. The dialogs render as
	// fixed-position overlays regardless of where in the tree they mount, and
	// stay OUTSIDE the gate so an open dialog survives a collapse — otherwise
	// the promise stashed by showConfirm() would never resolve.
	return (
		<>
			<SidebarCollapsedGate>
				<SidebarChrome
					items={buildBuiltinSidebarItems({
						agent: { agent, onShowIntro: handleShowIntro },
						appdev: { appBuilder, onShowIntro: handleShowIntro, onShowDesktop: handleShowDesktop },
						nodes: { onShowIntro: handleShowIntro },
						pipelines: {
							isConnected: connection.state === 'connected',
							entries,
							activeTasks,
							unknownTasks,
							activeFilePath,
							onNavigate: handleNavigate,
							onOpenFile: handleOpenFile,
							onFileManage: handleFileManage,
							fileActions: [{ id: 'export', label: 'Export', icon: <BxExport size={16} />, onSelect: handleExportPipeline }],
							onSourceAction: handleSourceAction,
							onOpenUnknownTask: handleOpenUnknownTask,
							onRefresh: refresh,
							onShowIntro: handleShowIntro,
						},
					})}
					fallbackId="pipelines"
					showModeStrip
					hideModeStrip={!!shellView}
					sidebarMode={effectiveMode}
					onSidebarModeChange={handleSidebarModeChange}
					toolTabs={toolTabs}
					tabOrder={tabOrder}
					onReorderTabs={setTabOrder}
				/>
			</SidebarCollapsedGate>
			{confirmState && <ConfirmDialog title={confirmState.title} message={confirmState.message} confirmLabel={confirmState.confirmLabel} cancelLabel="Cancel" onConfirm={() => handleConfirmResult(true)} onCancel={() => handleConfirmResult(false)} />}
			{actionError && <ConfirmDialog title="Pipeline Error" message={actionError} confirmLabel="OK" onConfirm={() => setActionError(null)} onCancel={() => setActionError(null)} />}
		</>
	);
};

export default SidebarProvider;
