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
// WORKSPACE EXPLORER — the raw workspace file tree (the rail's first view)
// =============================================================================
//
// VS Code's Explorer, over the staged workspace view: the WHOLE tree as it
// is on disk-equivalent (the three mounts and every file under them — no
// per-mode curation), with source-control decorations (M/A/D letters and
// tinted names from changedPaths()) and the unsaved-edit dot (dirtyPaths()).
// Staged (uncommitted) files list exactly like committed ones because every
// read goes through the view.
//
// Opening routes through the ONE table in workspace/openWorkspaceFile.ts —
// .pipe → canvas, .rrapp → App Builder, .rrnode reserved for the Node
// Designer, text-shaped files → the read-only viewer.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Explorer, NOOP_VFS, ConfirmDialog } from 'shell';
import type { ExplorerEntry, ExplorerConfig } from 'shell';
import { getWorkspaceVfs, getStagedWorkspace } from '../workspace/workspace';
import { openWorkspaceFile } from '../workspace/openWorkspaceFile';
import { getDocs } from '../docs';
import type { ChangeKind } from 'shared/workspace/stagedFileSystem';

// =============================================================================
// CONFIG
// =============================================================================

/** Explorer configuration: the raw tree, every file, folders allowed. */
const WORKSPACE_CONFIG: ExplorerConfig = {
	title: 'Workspace',
	extensions: null,
	createPlaceholder: 'file name',
	emptyMessage: 'Empty workspace',
	allowFolders: true,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The workspace Explorer container: builds the entry list, decorations, and
 * dirty markers from the shared workspace view, and routes every action
 * (open, rename, delete, create) back through it.
 */
const WorkspaceExplorerProvider: React.FC = () => {
	// --- Tree snapshot from the view's cached inventory -----------------------
	const [entries, setEntries] = useState<ExplorerEntry[]>([]);
	const [decorations, setDecorations] = useState<ReadonlyMap<string, ChangeKind>>(new Map());
	const [modifiedPaths, setModifiedPaths] = useState<ReadonlySet<string>>(new Set());

	/** Re-reads inventory, change decorations, and dirty overlays. */
	const snapshot = useCallback(() => {
		const view = getWorkspaceVfs();
		setEntries(view.listEntries().map((e) => ({ path: e.path, type: e.type })));
		setDecorations(getStagedWorkspace().changedPaths());
		setModifiedPaths(new Set(view.dirtyPaths()));
	}, []);

	// First snapshot synchronously (the view is ready before any consumer
	// renders — composition-root guarantee), then on every view change tick.
	useEffect(() => {
		snapshot();
		return getWorkspaceVfs().subscribe(snapshot);
	}, [snapshot]);

	/** Refresh button: re-walk the backend, then snapshot via the tick. */
	const handleRefresh = useCallback(() => {
		void getWorkspaceVfs().refresh();
	}, []);

	// --- Confirmation dialog (same pattern as the pipelines sidebar) ----------
	const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);
	const [confirmState, setConfirmState] = useState<{ title: string; message: string } | null>(null);
	/** A refused/failed action's message — rendered as a dismissable notice. */
	const [notice, setNotice] = useState<string | null>(null);

	/** Shows a confirm dialog; resolves true/false on the user's answer. */
	const showConfirm = useCallback((title: string, message: string): Promise<boolean> => {
		return new Promise((resolve) => {
			confirmResolveRef.current = resolve;
			setConfirmState({ title, message });
		});
	}, []);

	/** Dismisses the dialog and resolves the pending promise. */
	const handleConfirmResult = useCallback((confirmed: boolean) => {
		setConfirmState(null);
		const resolve = confirmResolveRef.current;
		confirmResolveRef.current = null;
		if (resolve) queueMicrotask(() => resolve(confirmed));
	}, []);

	// --- Open routing ----------------------------------------------------------
	const handleOpenFile = useCallback((path: string) => {
		void openWorkspaceFile(path);
	}, []);

	// --- File management through the view --------------------------------------
	// Mutations are STAGED like any other workspace write (manual mode) — a
	// rename or delete here is uncommitted, visible in Source Control, and
	// discardable, which is exactly the git-like contract.
	const handleFileManage = useCallback(
		async (action: 'rename' | 'delete' | 'createFolder' | 'createFile', path: string, newName?: string) => {
			const view = getWorkspaceVfs();
			try {
				// step: refuse creates outside the three mounts BEFORE staging —
				// a staged entry at the root passes silently here but fails every
				// later "Commit all" until the user finds and discards it
				if ((action === 'createFolder' || action === 'createFile') && !/^(apps|nodes|pipelines)\//.test(path)) {
					setNotice('Files live inside apps/, nodes/, or pipelines/ — select one of those folders first.');
					return;
				}
				switch (action) {
					case 'rename': {
						// `newName` is the full new leaf (no extension magic here —
						// the raw tree renames exactly what you type, as VS Code does).
						if (!newName) break;
						const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
						const newPath = dir ? `${dir}/${newName}` : newName;
						if (newPath === path) break;
						await view.rename(path, newPath);
						// Re-home any open editor tab (pipeline docs key on
						// mount-relative paths).
						if (path.startsWith('pipelines/')) {
							const docs = getDocs();
							const docPath = path.slice('pipelines/'.length);
							if (docs) {
								const st = docs.getState();
								const editorIds = Object.entries(st.editors)
									.filter(([, ed]) => ed.documentUri === docPath)
									.map(([id]) => id);
								for (const eid of editorIds) docs.closeEditor(eid);
								if (editorIds.length > 0) await docs.openDocument(newPath.slice('pipelines/'.length));
							}
						}
						break;
					}
					case 'delete': {
						const leaf = path.split('/').pop() ?? path;
						const confirmed = await showConfirm('Delete', `Are you sure you want to delete "${leaf}"?`);
						if (!confirmed) break;
						await view.delete(path);
						if (path.startsWith('pipelines/')) getDocs()?.discardDocument(path.slice('pipelines/'.length));
						break;
					}
					case 'createFolder':
						await view.mkdir(path);
						break;
					case 'createFile':
						await view.write(path, '');
						break;
				}
			} catch (err) {
				// step: the refusal reaches the USER — a console row is invisible
				// and the tree would just silently not change
				console.error('[WorkspaceExplorer] action failed:', action, err);
				setNotice(`Could not ${action === 'createFolder' ? 'create the folder' : action === 'createFile' ? 'create the file' : action} "${path}": ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		[showConfirm]
	);

	// --- Render ------------------------------------------------------------------
	return (
		<>
			<Explorer
				vfs={NOOP_VFS}
				config={WORKSPACE_CONFIG}
				entries={entries}
				isConnected
				showChildActions={false}
				decorations={decorations}
				modifiedPaths={modifiedPaths}
				onOpenFile={handleOpenFile}
				onFileManage={handleFileManage}
				onRefresh={handleRefresh}
			/>
			{confirmState && (
				<ConfirmDialog
					title={confirmState.title}
					message={confirmState.message}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					onConfirm={() => handleConfirmResult(true)}
					onCancel={() => handleConfirmResult(false)}
				/>
			)}
			{notice && (
				<ConfirmDialog
					title="Workspace"
					message={notice}
					confirmLabel="OK"
					cancelLabel="Close"
					onConfirm={() => setNotice(null)}
					onCancel={() => setNotice(null)}
				/>
			)}
		</>
	);
};

export default WorkspaceExplorerProvider;
