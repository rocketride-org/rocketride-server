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
import { getDocs } from '../../docs';
import { SidebarChrome } from 'shared/tools/core/chrome/SidebarChrome';
import { ToolHostProvider } from 'shared/tools/core';
import { useToolStrip } from 'shared/tools/core/chrome/useToolStrip';
import { toolDocUri } from 'shell';
import { useWorkspacePrefsStore } from '../workspace/vfs/workspacePrefsStore';
import type { BuiltinToolServices } from 'shared/tools/core';
import { registerBuiltinTools } from 'shared/tools/builtins';
import { appdevFrames } from '../appdev/session/appdevFrames';
import { BxExport, useSidebarCollapsed, useSidebarActiveView } from 'shell';
import type { ProjectEntry } from 'shared/tools/pipelines/sidebar/types';
import type { SidebarMode, ToolTabsSidebar } from 'shared/tools/core/chrome/types';
import type { AppListItem } from 'shared/tools/appdev/sidebarTypes';
import { useDevToolPins, toToolTab } from '../devtools/devToolPins';
import { getSidebarPeer, getToolChannel } from '../devtools/peer';
import DevToolMount from '../devtools/DevToolMount';
import { isPipelineFile, pipelineExtension } from '../workspace/projectStore';
import { createProjectVfs } from '../workspace/projectVfs';
import { getWorkspaceVfs, storePathToVirtual } from '../workspace/vfs/workspace';
import { downloadJson } from '../../utils/downloadFile';
import { scanApps } from '../appdev/session/appStore';
import { INTRO_PAGES } from 'shared/tools/introCatalog';
import type { IntroMode } from 'shared/tools/introCatalog';

// A TOOL IS AN APP: the builtin tools register once per realm; this host's
// sidebar renders them by iterating the registry.
registerBuiltinTools();

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
 * Renders shared's SidebarChrome over the builtin-tool registry and the
 * pinned store tools. Builds pipeline-specific data (entries with
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

	// Task state, folding, and per-source status live in the PIPELINES TOOL
	// now (shared tools/pipelines) — this host only feeds it the workspace
	// VIEW's entry list through the pipelineEntries service below.
	const entriesCurRef = useRef<ProjectEntry[]>([]);
	const entrySubsRef = useRef(new Set<(e: ProjectEntry[]) => void>());
	useEffect(() => {
		entriesCurRef.current = entries;
		entrySubsRef.current.forEach((cb) => cb(entries));
	}, [entries]);

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

			const uri = `pipeline:${projectId}.${sourceId}`;

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

	// The APPDEV TOOL owns the list; this host contributes only the
	// host-variant STREAM: the .appdev store scan (the web twin of VS Code's
	// workspace scan), re-run on the workspace view's change stream (staged
	// writes included) and the shell bus's cross-page fs notifies.
	const appdevApps = useMemo<NonNullable<BuiltinToolServices['appdevApps']>>(() => ({
		subscribe: (cb: (apps: AppListItem[]) => void) => {
			let seq = 0;
			const rescan = (): void => {
				const req = ++seq;
				const cm = ConnectionManager.getInstance();
				if (!cm.isConnected()) {
					cb([]);
					return;
				}
				scanApps()
					.then((scanned) => { if (req === seq) cb(scanned.map((a): AppListItem => ({ id: a.id, name: a.name }))); })
					.catch(() => { if (req === seq) cb([]); });
			};
			rescan();
			const cm = ConnectionManager.getInstance();
			const unsubView = getWorkspaceVfs().subscribe(rescan);
			const unsubBus = cm.on('shell:notify', (notification: ShellNotification) => {
				if (notification.kind !== 'onFsChange') return;
				if (storePathToVirtual(notification.uri)?.startsWith('apps')) rescan();
			});
			const unsubConn = cm.on('shell:connected', rescan);
			const unsubDisc = cm.on('shell:disconnected', rescan);
			return () => {
				seq++;
				unsubView();
				unsubBus();
				unsubConn();
				unsubDisc();
			};
		},
	}), []);

	// --- Agent (MY SESSIONS) ---------------------------------------------------
	// Fully owned by the AGENT TOOL (shared tools/agent) — nothing here.
	const { prefs, updatePrefs } = useWorkspace();

	// --- Dev tools (pinned tool tabs + catalog) --------------------------------

	// Pins, strip order, and the server's devTool catalog — prefs-backed, one
	// source of truth shared with RocketApp's rail containers.
	const { tabOrder, catalog: toolCatalog, pinnedTools, unpin: unpinTool, setTabOrder } = useDevToolPins();

	/** Opens (or focuses) a tool's frame as a `tool:<appId>` document. */
	const handleOpenTool = useCallback((id: string) => {
		const name = toolCatalog.find((a) => a.id === id)?.name ?? id;
		getDocs()?.openStaticDocument(`tool:${id}`, name);
	}, [toolCatalog]);

	/** Host REVEAL verb: bring an OPEN document of the tool forward — never
	 *  create one here (the activation emit lives in useToolStrip). */
	const revealTool = useCallback((id: string) => {
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
	// document — this host's `host.openToolPanel` implementation (the bus
	// peer emits the op; registration is the allowlist).
	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		return cm.handle('host.openToolPanel', (params) => {
			const { appId } = params as { appId: string };
			if (typeof appId === 'string' && appId) handleOpenTool(appId);
		});
	}, [handleOpenTool]);

	// The dev-tool tabs contract: presence adds the pinned tool tabs and the
	// Dev Tools catalog tab to the mode strip (classic mode); the workbench
	// rail mirrors the same pins through RocketApp's sidebarViews.
	// Builtin tools the user DISABLED (prefs-persisted; enable/disable only).
	const disabledBuiltins = useMemo<string[]>(() => (prefs?.disabledBuiltins as string[] | undefined) ?? [], [prefs]);

	/** Flips one builtin's enabled state. */
	const handleToggleBuiltin = useCallback((id: string, enabled: boolean) => {
		const next = enabled ? disabledBuiltins.filter((d) => d !== id) : [...disabledBuiltins.filter((d) => d !== id), id];
		updatePrefs({ disabledBuiltins: next });
	}, [disabledBuiltins, updatePrefs]);




	/** Opens an embedded page by key — the tools' generic page surface.
	 *  Intro keys derive their title from the page table; everything else
	 *  ('desktop', 'newapp', 'app:<id>', 'agent:<id>') opens at the key. */
	const openPage = useCallback((key: string, title?: string) => {
		const docs = getDocs();
		if (!docs) return;
		if (key.startsWith('intro:')) {
			const mode = key.slice('intro:'.length) as IntroMode;
			docs.openStaticDocument(key, INTRO_PAGES[mode]?.title ?? title ?? key);
			return;
		}
		docs.openStaticDocument(key, title ?? key);
	}, []);

	// This realm's prefs backend — per-tool partitions are carved off it in
	// the builtin render wrappers below.
	const prefsStore = useWorkspacePrefsStore();

	// The ONE services object the builtin tools read (ToolContext). Tools own
	// their state; this host contributes generic verbs + two host-variant
	// data sources (appdevScan, pipelineEntries).
	const toolServices = useMemo<BuiltinToolServices>(() => ({
		openPage,
		openFile: handleOpenFile,
		manageFile: handleFileManage,
		fileActions: [{ id: 'export', label: 'Export', icon: <BxExport size={16} />, onSelect: handleExportPipeline }],
		pipelineAction: handleSourceAction,
		newPipeline: () => handleNavigate('new'),
		openUnknownTask: handleOpenUnknownTask,
		activeDocKey: activeFilePath,
		appdevApps,
		appdevFrames,
		pipelineEntries: {
			subscribe: (cb: (e: ProjectEntry[]) => void) => {
				entrySubsRef.current.add(cb);
				cb(entriesCurRef.current);
				return () => { entrySubsRef.current.delete(cb); };
			},
			refresh,
		},
	}), [openPage, handleOpenFile, handleFileManage, handleExportPipeline, handleSourceAction, handleNavigate, handleOpenUnknownTask, showConfirm, activeFilePath, appdevApps, refresh]);

	// Shared builtin-strip glue: items (with per-tool scoped prefs), store
	// rows, and the activation/deactivation discipline — over this host's
	// per-tool peer/channel/documents and the Documents reveal verb.
	const documentsFor = useCallback((toolId: string) => ({
		open: (key: string, title: string) => getDocs()?.openStaticDocument(toolDocUri(toolId, key), title),
		close: (key: string) => getDocs()?.discardDocument(toolDocUri(toolId, key)),
	}), []);
	const channelFor = useCallback((toolId: string) => getToolChannel(toolId, 'sidebar'), []);
	const { builtinItems, builtinStoreRows, focusTool: handleFocusTool, deactivateReplacedTab, announceBuiltinSelected } = useToolStrip({
		host: 'rocket',
		services: toolServices,
		prefsStore,
		disabledBuiltins,
		peerFor: getSidebarPeer,
		channelFor,
		documentsFor,
		revealTool,
	});

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
		builtins: builtinStoreRows,
		onToggleBuiltin: handleToggleBuiltin,
	}), [pinnedTools, toolCatalog, handleOpenTool, handleFocusTool, unpinTool, builtinStoreRows, handleToggleBuiltin]);



	// --- Render ----------------------------------------------------------------

	// Mode tab selection (Agent | Apps | Nodes | Pipelines) — prefs-backed so
	// the choice survives reload via workspace state. Agent is the startup
	// default when no stored choice exists (requirement: default tab unless
	// workspace state says otherwise).
	// DELIBERATE per-host default: 'agent' on web, 'apps' in VS Code. A
	// persisted mode whose tool is disabled falls back in SidebarChrome.
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => (prefs?.sidebarMode as SidebarMode | undefined) ?? 'agent');
	// The TRUE previous mode, mirrored from state — only a strip selection
	// below emits the deactivation for the tab it replaces.
	const prevSidebarModeRef = useRef<SidebarMode>(sidebarMode);
	useEffect(() => { prevSidebarModeRef.current = sidebarMode; }, [sidebarMode]);

	const handleSidebarModeChange = useCallback(
		(mode: SidebarMode) => {
			deactivateReplacedTab(prevSidebarModeRef.current, mode);
			// Builtins mount in the strip itself — their activation (the
			// single-pane contract) rides the selection; MF pins get theirs
			// via SidebarChrome's onFocusTool.
			announceBuiltinSelected(mode);
			setSidebarMode(mode);
			updatePrefs({ sidebarMode: mode });
		},
		[updatePrefs, deactivateReplacedTab, announceBuiltinSelected]
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

	// Rail → frame: SELECTING a tool's rail/strip container is REVEAL-ONLY —
	// bring an already-open document of the tool forward, never create one.
	// The tool's own sidebar panel decides what documents open (a connection
	// row, a pipeline entry); the generic landing frame is never summoned by
	// a mere tab selection. Transitions only — a page boot restoring a
	// remembered tool selection must not reshuffle tabs either.
	const prevShellViewRef = useRef<string | undefined>(shellView?.activeViewId);
	useEffect(() => {
		const id = shellView?.activeViewId;
		const prev = prevShellViewRef.current;
		prevShellViewRef.current = id;
		if (!id || id === prev) return;
		// Deactivation for the rail container a tool tab just lost, FIRST —
		// then the successor's activation (reveal for MF pins via
		// handleFocusTool; builtins mount in place, event only).
		if (prev !== undefined) deactivateReplacedTab(prev, id);
		if (prev !== undefined && id.startsWith('tool:')) handleFocusTool(id.slice('tool:'.length));
		if (prev !== undefined) announceBuiltinSelected(id);
	}, [shellView?.activeViewId, handleFocusTool, deactivateReplacedTab, announceBuiltinSelected]);

	// Frame → rail: focusing a tool's document highlights its rail container
	// (the VS Code host's onPanelFocused → setModeExternal, in-tree). The
	// container id is the tool, so a per-document URI (`tool:<appId>/<docKey>`)
	// maps back to its tool's container. BUILTIN tools are declared on the
	// rail with BARE ids ('apps', 'agent', ...) — only MF pins use the
	// `tool:` prefix — so prefixing a builtin here would select a container
	// the rail never declares, which the workbench resolves to the DEFAULT
	// tab (Agent) and persists.
	const builtinItemsRef = useRef(builtinItems);
	builtinItemsRef.current = builtinItems;
	useEffect(() => {
		if (!shellView || !activeFilePath.startsWith('tool:')) return;
		const appId = activeFilePath.slice('tool:'.length).split('/')[0];
		const containerId = builtinItemsRef.current.some((i) => i.id === appId) ? appId : `tool:${appId}`;
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
				<ToolHostProvider value={toolServices}>
					<SidebarChrome
						items={builtinItems}
						showModeStrip
						hideModeStrip={!!shellView}
						sidebarMode={effectiveMode}
						onSidebarModeChange={handleSidebarModeChange}
						toolTabs={toolTabs}
						tabOrder={tabOrder}
						onReorderTabs={setTabOrder}
					/>
				</ToolHostProvider>
			</SidebarCollapsedGate>
			{confirmState && <ConfirmDialog title={confirmState.title} message={confirmState.message} confirmLabel={confirmState.confirmLabel} cancelLabel="Cancel" onConfirm={() => handleConfirmResult(true)} onCancel={() => handleConfirmResult(false)} />}
			{actionError && <ConfirmDialog title="Pipeline Error" message={actionError} confirmLabel="OK" onConfirm={() => setActionError(null)} onCancel={() => setActionError(null)} />}
		</>
	);
};

export default SidebarProvider;
