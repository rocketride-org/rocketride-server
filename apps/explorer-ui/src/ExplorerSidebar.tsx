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
import type { CSSProperties } from 'react';
import { useShellConnection } from 'shell';
import { Explorer } from 'shell';
import { BxDownload, BxDockLeft, SidebarCollapsedGate } from 'shell';
import type { ExplorerEntry, ExplorerConfig, ExplorerFileAction } from 'shell';
import type { IVirtualFileSystem, RocketRideClient, DevToolProps } from 'shell';
import { getMediaInfo } from './mediaTypes';
import { getCompatibleViewers, VIEWER_LABELS } from './viewerRegistry';
import type { ViewerId } from './viewerRegistry';
import { localDocsBridge, createPeerDocsBridge } from './explorerBridge';
import type { ExplorerDocsBridge } from './explorerBridge';

// =============================================================================
// CONFIG
// =============================================================================

/** Explorer configuration for the store file browser. */
const EXPLORER_CONFIG: ExplorerConfig = {
	title: 'Files',
	emptyMessage: 'No files in store',
	allowFolders: true,
};

/**
 * No-op VFS for the file Explorer.
 *
 * The Explorer sidebar performs all file operations through the onFileManage /
 * onMove / onUpload callbacks (which call the RocketRide client directly), so
 * this stub satisfies the Explorer contract without exposing raw VFS access.
 */
const NOOP_VFS: IVirtualFileSystem = {
	list: async () => [],
	read: async () => null,
	write: async () => {},
	rename: async () => {},
	delete: async () => {},
	mkdir: async () => {},
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Sidebar content wrapper — fills the shell frame's scrolling slot. */
	sidebar: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Sidebar for the File Explorer app.
 *
 * The app's AppLayout sidebar node: builds the file-tree Explorer and renders
 * it behind a SidebarCollapsedGate (this free-form content has no icon-rail
 * form). ExplorerApp passes this component as its root layout's `sidebar`
 * prop. Files open in the Documents tab system on click.
 */
const ExplorerSidebar: React.FC<{ bridge?: ExplorerDocsBridge; gated?: boolean }> = ({ bridge = localDocsBridge, gated = true }) => {
	const { client, isConnected } = useShellConnection();
	const [entries, setEntries] = useState<ExplorerEntry[]>([]);

	// Active file path (for highlighting) — from the bridge: the Documents
	// store in-app, the frame's `active` peer feed as a devToolSidebar.
	const [activeFile, setActiveFile] = useState('');
	useEffect(() => bridge.subscribeActive(setActiveFile), [bridge]);

	// --- Refresh file list (recursive) ----------------------------------------

	const refresh = useCallback(async () => {
		if (!client || !isConnected) { setEntries([]); return; }
		try {
			const allEntries = await listRecursive(client, '@');
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
		bridge.open(path);
	}, [entries, bridge]);

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
					// Re-point open editor tabs (local or over the peer channel)
					bridge.renamed(path, newPath);
					break;
				}
				case 'delete': {
					const stat = await client.fsStat(path);
					if (stat.type === 'dir') {
						await client.fsRmdir(path, true);
					} else {
						await client.fsDelete(path);
					}
					bridge.deleted(path);
					break;
				}
				case 'createFile': {
					await client.fsWriteString(path, '');
					bridge.open(path);
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
			// The tree is rooted at the '@' mount (listRecursive above), so an
			// empty targetDir IS that root — carry '@' through instead of
			// letting a bare name silently target the plain user store.
			const newPath = `${targetDir || '@'}/${name}`;
			if (newPath === sourcePath) return;
			await client.fsRename(sourcePath, newPath);
			// Keep open editor tabs in sync with the move (local or peer).
			bridge.moved(sourcePath, newPath);
			await refresh();
		} catch (err) {
			console.error('[ExplorerSidebar] move failed:', err);
		}
	}, [client, refresh, bridge]);

	// --- Upload (drop from OS) ------------------------------------------------

	const handleUpload = useCallback(async (files: File[], targetDir: string) => {
		if (!client) return;
		try {
			for (const file of files) {
				// Same root rule as handleMove: '' targetDir is the '@' mount.
				const path = `${targetDir || '@'}/${file.name}`;
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
		bridge.openWith(path, viewerId);
	}, [bridge]);

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

	// --- Register sidebar content ---------------------------------------------

	// Build the file-tree node and publish it to the shell sidebar's scrolling
	// slot. The shell frame owns the collapse behaviour and hides free-form
	// content while collapsed, so no collapsed icon rail is drawn here.
	const content = (
		<div style={styles.sidebar}>
			<Explorer
				vfs={NOOP_VFS}
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

	// In-app: render behind the collapse gate — this free-form content has no
	// icon-rail form, so it hides while the shell sidebar is collapsed. As a
	// devToolSidebar there is no shell frame; the host panel owns visibility.
	return gated ? <SidebarCollapsedGate>{content}</SidebarCollapsedGate> : content;
};

/**
 * The tree as a host-mounted devToolSidebar: document actions ride the peer
 * channel to the frame (which owns Documents), and the active-path highlight
 * arrives back the same way.
 */
export const ExplorerDevToolSidebar: React.FC<DevToolProps> = ({ peer }) => {
	const bridge = useMemo(() => createPeerDocsBridge(peer), [peer]);
	return <ExplorerSidebar bridge={bridge} gated={false} />;
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
	client: RocketRideClient,
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
