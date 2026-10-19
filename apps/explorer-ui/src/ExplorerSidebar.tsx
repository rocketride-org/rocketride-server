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
import { ConnectionManager, useShellConnection, useShellEvent } from 'shell';
import { Explorer, createToolOpServer } from 'shell';
import type { ExplorerOps } from './ops';
import { BxDownload, BxDockLeft, SidebarCollapsedGate } from 'shell';
import type { ExplorerEntry, ExplorerConfig, ExplorerFileAction } from 'shell';
import type { IVirtualFileSystem, DevToolProps } from 'shell';
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
	const { isConnected } = useShellConnection();
	// Engine access rides the SHELL BUS (brokered client.* ops) — this realm
	// holds no client object and no socket.
	const cm = ConnectionManager.getInstance();
	const [entries, setEntries] = useState<ExplorerEntry[]>([]);

	// Active file path (for highlighting) — from the bridge: the Documents
	// store in-app, the frame's `active` peer feed as a devToolSidebar.
	const [activeFile, setActiveFile] = useState('');
	useEffect(() => bridge.subscribeActive(setActiveFile), [bridge]);

	// --- Refresh file list (recursive) ----------------------------------------

	const refresh = useCallback(async () => {
		if (!isConnected) { setEntries([]); return; }
		try {
			const allEntries = await listRecursive('@');
			setEntries(allEntries);
		} catch {
			setEntries([]);
		}
	}, [isConnected]);

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
		if (!isConnected) return;
		try {
			switch (action) {
				case 'rename': {
					if (!newName) break;
					const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
					const newPath = dir ? `${dir}/${newName}` : newName;
					if (newPath === path) break;
					await cm.request('client.fsRename', { from: path, to: newPath });
					// Re-point open editor tabs (local or over the peer channel)
					bridge.renamed(path, newPath);
					break;
				}
				case 'delete': {
					const stat = await cm.request('client.fsStat', { path }) as { type?: string };
					if (stat.type === 'dir') {
						await cm.request('client.fsRmdir', { path, recursive: true });
					} else {
						await cm.request('client.fsDelete', { path });
					}
					bridge.deleted(path);
					break;
				}
				case 'createFile': {
					await cm.request('client.fsWriteString', { path, text: '' });
					bridge.open(path);
					break;
				}
				case 'createFolder': {
					await cm.request('client.fsMkdir', { path });
					break;
				}
			}
			await refresh();
		} catch (err) {
			console.error(`[ExplorerSidebar] ${action} failed:`, err);
		}
	}, [isConnected, cm, refresh]);

	// --- Move (drag within tree) ----------------------------------------------

	const handleMove = useCallback(async (sourcePath: string, targetDir: string) => {
		if (!isConnected) return;
		try {
			const name = sourcePath.includes('/') ? sourcePath.substring(sourcePath.lastIndexOf('/') + 1) : sourcePath;
			// The tree is rooted at the '@' mount (listRecursive above), so an
			// empty targetDir IS that root — carry '@' through instead of
			// letting a bare name silently target the plain user store.
			const newPath = `${targetDir || '@'}/${name}`;
			if (newPath === sourcePath) return;
			await cm.request('client.fsRename', { from: sourcePath, to: newPath });
			// Keep open editor tabs in sync with the move (local or peer).
			bridge.moved(sourcePath, newPath);
			await refresh();
		} catch (err) {
			console.error('[ExplorerSidebar] move failed:', err);
		}
	}, [isConnected, cm, refresh, bridge]);

	// --- Upload (drop from OS) ------------------------------------------------

	const handleUpload = useCallback(async (files: File[], targetDir: string) => {
		if (!isConnected) return;
		try {
			for (const file of files) {
				// Same root rule as handleMove: '' targetDir is the '@' mount.
				const path = `${targetDir || '@'}/${file.name}`;
				const { handle } = await cm.request('client.fsOpen', { path, mode: 'w' }) as { handle: unknown };
				// 1 MB chunks: write bytes ride the bus base64-encoded (the
				// JSON-safe binary rule), so keep frames postMessage-friendly.
				const chunkSize = 1024 * 1024;
				try {
					// Stream the file in chunks via File.slice so we never
					// buffer the entire file in memory at once.
					let offset = 0;
					while (offset < file.size) {
						const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
						await cm.request('client.fsWrite', { handle, dataB64: bytesToB64(chunk) });
						offset += chunkSize;
					}
				} finally {
					// Always close the handle, even if a write throws mid-stream.
					await cm.request('client.fsClose', { handle, mode: 'w' });
				}
			}
			await refresh();
		} catch (err) {
			console.error('[ExplorerSidebar] upload failed:', err);
		}
	}, [isConnected, cm, refresh]);

	// --- Download (kebab menu action) -----------------------------------------

	const handleDownload = useCallback(async (path: string) => {
		if (!isConnected) return;
		try {
			const name = path.includes('/') ? path.substring(path.lastIndexOf('/') + 1) : path;
			// Pass downloadName so the server bakes `Content-Disposition:
			// attachment; filename="<name>"` into the URL (presigned/SAS for
			// cloud, /task/fetch header for local). This makes the download
			// filename work even for cross-origin cloud URLs, where the
			// `<a download>` attribute is otherwise ignored.
			const url = await cm.request('client.fsGetUrl', { path, downloadName: name }) as string;
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
	}, [isConnected, cm]);

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
export const ExplorerDevToolSidebar: React.FC<DevToolProps> = ({ peer, documents }) => {
	const bridge = useMemo(() => createPeerDocsBridge(peer), [peer]);

	// SINGLE-PANE UX: the explorer's editor surface is one pane, so
	// activating its sidebar tab opens (or reveals) it — the tool's choice.
	// This mount only exists because the tab was selected, so mounting IS
	// the first activation; the shell event covers re-selections.
	useEffect(() => { documents?.open('', 'File Explorer'); }, [documents]);
	useShellEvent('shell:toolSidebarActivated', ({ appId }) => {
		if (appId === 'rocketride.explorer') documents?.open('', 'File Explorer');
	});

	// ── CONTROLLER duties: the frame holds no RocketRide client ──────────────

	// The frame's store surface, served on this mount's engine connection.
	useEffect(() => {
		const ops = createToolOpServer<ExplorerOps>(peer);
		// Served over the SHELL BUS — the controller realm needs no client
		// object (brokered client.* ops; connection liveness is bus-mirrored).
		const cm = ConnectionManager.getInstance();
		const need = (): void => {
			if (!cm.isConnected()) throw new Error('Not connected to a server.');
		};
		ops.serve('explorer.listDir', async ({ dir }) => {
			need();
			const result = await cm.request('client.fsListDir', { path: dir }) as { entries?: Array<{ name: string; type: string }> };
			return (result.entries ?? []).map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' as const : 'file' as const }));
		});
		ops.serve('explorer.readString', async ({ path }) => { need(); return cm.request('client.fsReadString', { path }) as Promise<string>; });
		ops.serve('explorer.getUrl', async ({ path }) => { need(); return cm.request('client.fsGetUrl', { path }) as Promise<string>; });
		ops.serve('explorer.writeString', async ({ path, content }) => { need(); await cm.request('client.fsWriteString', { path, text: content }); });
		ops.serve('explorer.rename', async ({ oldPath, newPath }) => { need(); await cm.request('client.fsRename', { from: oldPath, to: newPath }); });
		ops.serve('explorer.stat', async ({ path }) => {
			need();
			const stat = await cm.request('client.fsStat', { path }) as { type?: 'file' | 'dir'; size?: number };
			return { ...(stat.type !== undefined ? { type: stat.type } : {}), ...(stat.size !== undefined ? { size: stat.size } : {}) };
		});
		ops.serve('explorer.remove', async ({ path }) => {
			need();
			const stat = await cm.request('client.fsStat', { path }) as { type?: string };
			if (stat.type === 'dir') await cm.request('client.fsRmdir', { path, recursive: true });
			else await cm.request('client.fsDelete', { path });
		});
		ops.serve('explorer.mkdir', async ({ path }) => { need(); await cm.request('client.fsMkdir', { path }); });
		return () => ops.dispose();
	}, [peer]);

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
	dir: string,
): Promise<ExplorerEntry[]> {
	const result = await ConnectionManager.getInstance().request('client.fsListDir', { path: dir }) as { entries?: Array<{ name: string; type?: 'file' | 'dir' }> };
	const entries: ExplorerEntry[] = [];

	for (const item of result.entries ?? []) {
		const path = dir ? `${dir}/${item.name}` : item.name;
		entries.push({ path, type: item.type ?? 'file' });

		if (item.type === 'dir') {
			try {
				const children = await listRecursive(path);
				entries.push(...children);
			} catch {
				// Skip inaccessible directories
			}
		}
	}

	return entries;
}

export default ExplorerSidebar;

/**
 * Encodes bytes for the bus's JSON-safe binary rule (clientOps fsWrite) —
 * chunked so large frames never blow the call stack via spread.
 *
 * @param bytes - The chunk to encode.
 * @returns Base64 text.
 */
function bytesToB64(bytes: Uint8Array): string {
	let bin = '';
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		bin += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(bin);
}
