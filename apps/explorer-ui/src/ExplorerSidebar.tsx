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
// EXPLORER SIDEBAR — file tree for the RocketRide server store
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ShellSidebarProps } from 'shell-ui';
import { useShellConnection } from 'shell-ui';
import { Explorer, BxDownload, BxDockLeft } from 'shared';
import type { ExplorerEntry, ExplorerConfig, ExplorerFileAction, IVirtualFileSystem } from 'shared';
import { getDocs } from './docs';
import { getMediaInfo } from './mediaTypes';
import { getCompatibleViewers, VIEWER_LABELS } from './viewerRegistry';
import type { ViewerId } from './viewerRegistry';

// =============================================================================
// CONFIG
// =============================================================================

/** Explorer configuration for the store file browser. */
const EXPLORER_CONFIG: ExplorerConfig = {
	title: 'Files',
	emptyMessage: 'No files in store',
	allowFolders: true,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Sidebar for the File Explorer app.
 *
 * Uses the shared Explorer component for the file tree with built-in
 * rename, delete, create file, and create folder support.  Files are
 * opened in the Documents tab system on click.
 */
const ExplorerSidebar: React.FC<ShellSidebarProps> = ({ collapsed }) => {
	const { client, isConnected } = useShellConnection();
	const [entries, setEntries] = useState<ExplorerEntry[]>([]);

	// Active file path from Documents (for highlighting)
	const [activeFile, setActiveFile] = useState('');
	useEffect(() => {
		const docs = getDocs();
		if (!docs) return;
		const readActive = (): string => {
			const s = docs.getState();
			const group = s.groups[s.activeGroupId];
			if (!group) return '';
			const editorId = group.editorIds[group.activeEditorIndex];
			return editorId ? (s.editors[editorId]?.documentUri ?? '') : '';
		};
		setActiveFile(readActive());
		return docs.subscribe(() => setActiveFile(readActive()));
	}, []);

	// --- Refresh file list (recursive) ----------------------------------------

	const refresh = useCallback(async () => {
		if (!client || !isConnected) { setEntries([]); return; }
		try {
			const allEntries = await listRecursive(client, '');
			setEntries(allEntries);
		} catch {
			setEntries([]);
		}
	}, [client, isConnected]);

	// Refresh on mount and when connection changes
	useEffect(() => { refresh(); }, [refresh]);

	// --- Open a file ----------------------------------------------------------

	const handleOpenFile = useCallback((path: string) => {
		const entry = entries.find((e) => e.path === path);
		// Don't try to open directories as documents
		if (entry?.type === 'dir') return;
		getDocs()?.openDocument(path);
	}, [entries]);

	// --- File management (rename, delete, createFile, createFolder) -----------

	const handleFileManage = useCallback(async (
		action: 'rename' | 'delete' | 'createFolder' | 'createFile',
		path: string,
		newName?: string,
	) => {
		if (!client) return;
		try {
			switch (action) {
				case 'rename': {
					if (!newName) break;
					const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
					const newPath = dir ? `${dir}/${newName}` : newName;
					if (newPath === path) break;
					await client.fsRename(path, newPath);
					// Update open editor tabs
					const docs = getDocs();
					if (docs) {
						const s = docs.getState();
						const editorIds = Object.entries(s.editors)
							.filter(([, ed]) => ed.documentUri === path)
							.map(([id]) => id);
						for (const eid of editorIds) docs.closeEditor(eid);
						if (editorIds.length > 0) await docs.openDocument(newPath);
					}
					break;
				}
				case 'delete': {
					const stat = await client.fsStat(path);
					if (stat.type === 'dir') {
						await client.fsRmdir(path, true);
					} else {
						await client.fsDelete(path);
					}
					getDocs()?.discardDocument(path);
					break;
				}
				case 'createFile': {
					await client.fsWriteString(path, '');
					getDocs()?.openDocument(path);
					break;
				}
				case 'createFolder': {
					await client.fsMkdir(path);
					break;
				}
			}
			await refresh();
		} catch (err) {
			console.error(`[ExplorerSidebar] ${action} failed:`, err);
		}
	}, [client, refresh]);

	// --- Move (drag within tree) ----------------------------------------------

	const handleMove = useCallback(async (sourcePath: string, targetDir: string) => {
		if (!client) return;
		try {
			const name = sourcePath.includes('/') ? sourcePath.substring(sourcePath.lastIndexOf('/') + 1) : sourcePath;
			const newPath = targetDir ? `${targetDir}/${name}` : name;
			if (newPath === sourcePath) return;
			await client.fsRename(sourcePath, newPath);
			// Keep open editor tabs in sync with the move.  A moved file must
			// re-point its tab at the new path; a moved directory must re-point
			// every open tab whose path lives under the old directory prefix.
			const docs = getDocs();
			if (docs) {
				const s = docs.getState();
				const dirPrefix = `${sourcePath}/`;
				const affected = Object.entries(s.editors)
					.map(([id, ed]) => ({ id, uri: ed.documentUri }))
					.filter(({ uri }) => uri === sourcePath || uri.startsWith(dirPrefix));
				// Compute each affected tab's new path, close the stale editors,
				// then reopen at the relocated paths.
				const reopenPaths: string[] = [];
				for (const { id, uri } of affected) {
					const movedUri = uri === sourcePath ? newPath : `${newPath}/${uri.slice(dirPrefix.length)}`;
					reopenPaths.push(movedUri);
					docs.closeEditor(id);
				}
				for (const movedUri of reopenPaths) await docs.openDocument(movedUri);
			}
			await refresh();
		} catch (err) {
			console.error('[ExplorerSidebar] move failed:', err);
		}
	}, [client, refresh]);

	// --- Upload (drop from OS) ------------------------------------------------

	const handleUpload = useCallback(async (files: File[], targetDir: string) => {
		if (!client) return;
		try {
			for (const file of files) {
				const path = targetDir ? `${targetDir}/${file.name}` : file.name;
				const { handle } = await client.fsOpen(path, 'w');
				const chunkSize = 4 * 1024 * 1024; // 4 MB
				try {
					// Stream the file in chunks via File.slice so we never
					// buffer the entire file in memory at once.
					let offset = 0;
					while (offset < file.size) {
						const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
						await client.fsWrite(handle, chunk);
						offset += chunkSize;
					}
				} finally {
					// Always close the handle, even if a write throws mid-stream.
					await client.fsClose(handle, 'w');
				}
			}
			await refresh();
		} catch (err) {
			console.error('[ExplorerSidebar] upload failed:', err);
		}
	}, [client, refresh]);

	// --- Download (kebab menu action) -----------------------------------------

	const handleDownload = useCallback(async (path: string) => {
		if (!client) return;
		try {
			const name = path.includes('/') ? path.substring(path.lastIndexOf('/') + 1) : path;
			// Pass downloadName so the server bakes `Content-Disposition:
			// attachment; filename="<name>"` into the URL (presigned/SAS for
			// cloud, /task/fetch header for local). This makes the download
			// filename work even for cross-origin cloud URLs, where the
			// `<a download>` attribute is otherwise ignored.
			const url = await client.fsGetUrl(path, undefined, name);
			if (!url) return;
			const a = document.createElement('a');
			a.href = url;
			a.download = name; // same-origin belt-and-suspenders
			document.body.appendChild(a);
			a.click();
			a.remove();
		} catch (err) {
			console.error('[ExplorerSidebar] download failed:', err);
		}
	}, [client]);

	// --- Open with... handler ----------------------------------------------------

	const handleOpenWith = useCallback((path: string, viewerId: ViewerId) => {
		const docs = getDocs();
		if (!docs) return;

		// Open the file (may already be open)
		docs.openDocument(path).then(() => {
			const s = docs.getState();
			const group = s.groups[s.activeGroupId];
			if (!group) return;
			// Find the editor for this URI in the active group
			const editorId = group.editorIds.find(eid => s.editors[eid]?.documentUri === path);
			if (!editorId) return;
			docs.updateEditorViewState(editorId, { ...s.editors[editorId]?.viewState, viewerId });
		});
	}, []);

	// --- File actions (kebab menu) -------------------------------------------

	const buildOpenWithChildren = useCallback((path: string): ExplorerFileAction[] => {
		const { category } = getMediaInfo(path);
		return getCompatibleViewers(category).map(vid => ({
			id: `open-with-${vid}`,
			label: VIEWER_LABELS[vid],
			onSelect: (p: string) => handleOpenWith(p, vid),
		}));
	}, [handleOpenWith]);

	const fileActions: ExplorerFileAction[] = useMemo(() => [
		{
			id: 'open-with',
			label: 'Open with\u2026',
			icon: <BxDockLeft size={16} />,
			children: buildOpenWithChildren,
		},
		{ id: 'download', label: 'Download', icon: <BxDownload size={16} />, onSelect: handleDownload },
	], [buildOpenWithChildren, handleDownload]);

	// --- Collapsed mode -------------------------------------------------------

	if (collapsed) {
		return null;
	}

	// --- Expanded mode --------------------------------------------------------

	// Use a no-op VFS for the Explorer — we handle all operations via callbacks
	const noopVfs: IVirtualFileSystem = {
		list: async () => [],
		read: async () => null,
		write: async () => {},
		rename: async () => {},
		delete: async () => {},
		mkdir: async () => {},
	};

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			<Explorer
				vfs={noopVfs}
				config={EXPLORER_CONFIG}
				entries={entries}
				isConnected={isConnected}
				activeFilePath={activeFile}
				onOpenFile={handleOpenFile}
				onFileManage={handleFileManage}
				onRefresh={refresh}
				onMove={handleMove}
				onUpload={handleUpload}
				fileActions={fileActions}
			/>
		</div>
	);
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Recursively lists all files and directories from the server store,
 * building a flat ExplorerEntry[] array that the Explorer component
 * can derive its tree hierarchy from.
 */
async function listRecursive(
	client: any,
	dir: string,
): Promise<ExplorerEntry[]> {
	const result = await client.fsListDir(dir);
	const entries: ExplorerEntry[] = [];

	for (const item of result.entries ?? []) {
		const path = dir ? `${dir}/${item.name}` : item.name;
		entries.push({ path, type: item.type ?? 'file' });

		if (item.type === 'dir') {
			try {
				const children = await listRecursive(client, path);
				entries.push(...children);
			} catch {
				// Skip inaccessible directories
			}
		}
	}

	return entries;
}

export default ExplorerSidebar;
