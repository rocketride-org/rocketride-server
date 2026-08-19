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
import { useShellConnection, ConnectionManager, ConfirmDialog } from 'shell';
import { getDocs } from '../docs';
import { SidebarView } from 'shared/modules/sidebar/SidebarView';
import { BxExport, useSidebarCollapsed } from 'shell';
import { foldTaskEvent } from 'shared/modules/sidebar/taskFold';
import type { ProjectEntry, ActiveTaskState, UnknownTask, ConnectionInfo, SidebarMode } from 'shared/modules/sidebar/types';
import type { TaskLifecycleEvent } from 'shared/modules/sidebar/taskFold';
import { loadProject, listProjectDir, isPipelineFile, pipelineExtension } from '../utils/projectStore';
import { downloadJson } from '../utils/downloadFile';

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
			// Recursive list
			const listRecursive = async (dir: string): Promise<ProjectEntry[]> => {
				const result = await listProjectDir(client, dir);
				const out: ProjectEntry[] = [];
				for (const e of result.entries ?? []) {
					const path = dir ? `${dir}/${e.name}` : e.name;
					if (e.type === 'dir') {
						out.push({ path, type: 'dir' });
						out.push(...(await listRecursive(path)));
					} else if (isPipelineFile(e.name)) {
						// Parse pipeline for projectId + sources
						try {
							const pipeline = await loadProject(client, path);
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
		} else if (target === 'monitor') {
			docs.openStaticDocument('monitor', 'Monitor');
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
			const { saveProject, deleteProject, renameProject, mkdirProject, rmdirProject } = await import('../utils/projectStore');
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
							await renameProject(client, path, newPath);
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

						// Server's fs_delete only handles files; folders need fs_rmdir.
						const isFile = isPipelineFile(path);
						if (isFile) await deleteProject(client, path);
						else await rmdirProject(client, path);

						// Force-remove the document and all editors regardless of dirty state
						// so stale content doesn't linger if a new file reuses the same name
						getDocs()?.discardDocument(path);
						break;
					}
					case 'createFolder':
						await mkdirProject(client, path);
						break;
					case 'createFile':
						await saveProject(client, path, { project_id: crypto.randomUUID(), components: [] });
						break;
				}
				refresh();
			} catch (err) {
				// Constant format string (SAST rule): the action rides as an arg.
				console.error('[SidebarProvider] action failed:', action, err);
			}
		},
		[client, refresh]
	);

	/**
	 * Exports a pipeline as a downloaded .pipe file. SaaS-only — injected into
	 * the Explorer kebab via `fileActions`; the VS Code host omits it.
	 */
	const handleExportPipeline = useCallback(
		async (path: string) => {
			if (!client) return;
			try {
				const pipeline = await loadProject(client, path);
				const filename = path.split('/').pop() ?? 'pipeline.pipe';
				downloadJson(filename, pipeline);
			} catch (err) {
				console.error('[SidebarProvider] export failed:', err);
			}
		},
		[client]
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
					const pipeline = await loadProject(client, filePath);
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

	// --- Render ----------------------------------------------------------------

	// Mode tab selection (Pipelines | Nodes on this host — no app builder).
	// Session-scoped only, matching the VS Code host's session persistence.
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>('pipelines');

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
				<SidebarView connection={connection} entries={entries} activeTasks={activeTasks} unknownTasks={unknownTasks} activeFilePath={activeFilePath} onNavigate={handleNavigate} onOpenFile={handleOpenFile} onFileManage={handleFileManage} fileActions={[{ id: 'export', label: 'Export', icon: <BxExport size={16} />, onSelect: handleExportPipeline }]} onSourceAction={handleSourceAction} onOpenUnknownTask={handleOpenUnknownTask} onRefresh={refresh} showModeStrip sidebarMode={sidebarMode} onSidebarModeChange={setSidebarMode} />
			</SidebarCollapsedGate>
			{confirmState && <ConfirmDialog title={confirmState.title} message={confirmState.message} confirmLabel={confirmState.confirmLabel} cancelLabel="Cancel" onConfirm={() => handleConfirmResult(true)} onCancel={() => handleConfirmResult(false)} />}
			{actionError && <ConfirmDialog title="Pipeline Error" message={actionError} confirmLabel="OK" onConfirm={() => setActionError(null)} onCancel={() => setActionError(null)} />}
		</>
	);
};

export default SidebarProvider;
