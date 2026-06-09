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
// APARAVI SIDEBAR — chat file list using shared Explorer component
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { ShellSidebarProps } from 'shell-ui';
import { useShellConnection, NavButton, BxPlus } from 'shell-ui';
import { Explorer } from 'shared';
import type { ExplorerEntry, ExplorerConfig, IVirtualFileSystem } from 'shared';
import { getDocs } from './docs';
import { listChatDir, saveChat, deleteChat, renameChat } from './chatStore';

// =============================================================================
// CONFIG
// =============================================================================

/** Explorer configuration for chat files. */
const CHAT_CONFIG: ExplorerConfig = {
	title: 'Chats',
	extensions: ['.chat'],
	displayName: (name: string) => name.replace(/\.chat$/, '') || name,
	createPlaceholder: 'chat name',
	emptyMessage: 'No saved chats',
	allowFolders: false,
};

/**
 * No-op VFS for the chat Explorer.
 *
 * The Aparavi sidebar manages file operations via onFileManage callbacks
 * (which use the chatStore helpers) rather than through the VFS interface.
 * This stub satisfies the Explorer contract without exposing raw VFS access.
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
// COMPONENT
// =============================================================================

/**
 * Sidebar for the Aparavi AQL Chat app.
 *
 * Uses the shared Explorer component for the chat file list with built-in
 * rename, delete, and create support. New chats are created as .chat files
 * in the .chats/ workspace directory.
 */
const AparaviSidebar: React.FC<ShellSidebarProps> = ({ collapsed }) => {
	const { client, isConnected } = useShellConnection();
	const [entries, setEntries] = useState<ExplorerEntry[]>([]);

	// Active file path from Documents (for highlighting)
	const [activeFile, setActiveFile] = useState('');
	useEffect(() => {
		const docs = getDocs();
		if (!docs) return;
		/** Read the active editor's document URI. */
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

	// --- Refresh file list ----------------------------------------------------

	const refresh = useCallback(async () => {
		if (!client || !isConnected) { setEntries([]); return; }
		try {
			const result = await listChatDir(client, '');
			const chatFiles: ExplorerEntry[] = (result.entries ?? [])
				.filter((e: any) => e.name?.endsWith('.chat'))
				.map((e: any) => ({ path: e.name, type: 'file' as const }));
			setEntries(chatFiles);
		} catch {
			setEntries([]);
		}
	}, [client, isConnected]);

	// Refresh on mount and when connection changes
	useEffect(() => { refresh(); }, [refresh]);

	// --- Create new chat ------------------------------------------------------

	const handleNewChat = useCallback(async () => {
		if (!client) return;
		// Generate a unique name
		const existing = new Set(entries.map((e) => e.path));
		let n = 1;
		while (existing.has(`Chat ${n}.chat`)) n++;
		const fileName = `Chat ${n}.chat`;

		// Create the file on disk with empty messages
		try {
			await saveChat(client, fileName, { messages: [] });
			await refresh();
			// Open it in the editor
			getDocs()?.openDocument(fileName);
		} catch (err) {
			console.error('[AparaviSidebar] Failed to create chat:', err);
		}
	}, [client, entries, refresh]);

	// --- Open a chat file -----------------------------------------------------

	const handleOpenFile = useCallback((path: string) => {
		getDocs()?.openDocument(path);
	}, []);

	// --- File management (rename, delete, createFile) -------------------------

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
					const newPath = dir
						? `${dir}/${newName}.chat`
						: `${newName}.chat`;
					if (newPath === path) break;
					await renameChat(client, path, newPath);
					// Update open editor tabs: close old, reopen at new path
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
					await deleteChat(client, path);
					// Force-remove the document and all editors regardless of dirty state
					// so stale content doesn't linger if a new chat reuses the same name
					getDocs()?.discardDocument(path);
					break;
				}
				case 'createFile': {
					await saveChat(client, path, { messages: [] });
					getDocs()?.openDocument(path);
					break;
				}
			}
			await refresh();
		} catch (err) {
			console.error(`[AparaviSidebar] ${action} failed:`, err);
		}
	}, [client, refresh]);

	// --- Collapsed mode -------------------------------------------------------

	if (collapsed) {
		return (
			<div style={{ padding: '4px 8px' }}>
				<NavButton icon={BxPlus} label="New Chat" collapsed onClick={handleNewChat} />
			</div>
		);
	}

	// --- Expanded mode --------------------------------------------------------

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			{/* New Chat button */}
			<div style={{ padding: '4px 4px 0' }}>
				<NavButton icon={BxPlus} label="New Chat" collapsed={false} onClick={handleNewChat} />
			</div>

			{/* Chat file tree (shared Explorer component) */}
			<Explorer
				vfs={NOOP_VFS}
				config={CHAT_CONFIG}
				entries={entries}
				isConnected={isConnected}
				activeFilePath={activeFile}
				onOpenFile={handleOpenFile}
				onFileManage={handleFileManage}
				onRefresh={refresh}
			/>
		</div>
	);
};

export default AparaviSidebar;
