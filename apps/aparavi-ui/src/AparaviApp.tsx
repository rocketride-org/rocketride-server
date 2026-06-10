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
// APARAVI APP — multi-tab persistent chat for Aparavi AQL queries
// =============================================================================
//
// Uses the Documents library for multi-tab support. Each tab is an independent
// chat session persisted as a .chat JSON file via the workspace VFS.
//
// On connect, starts the Aparavi pipeline via client.use() and obtains a
// pipeline token shared across all chat tabs.
//
// Pipeline: Chat → CrewAI Agent → Aparavi AQL tool + LLM → Response
// =============================================================================

import React, { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell-ui';
import type { IVirtualFileSystem } from 'shared/modules/explorer/types';
import { commonStyles } from 'shared/themes/styles';
import { useShellConnection, useAuthUser, useWorkspace, DocTabs, DocSplitLayout } from 'shell-ui';
import type { Documents } from 'shell-ui';
import { ChatView, useChatMessages } from 'shared';
import type { ChatMessage } from 'shared';
import { createDocs, destroyDocs, getDocs } from './docs';
import { loadChat, saveChat, listChatDir, renameChat, deleteChat } from './chatStore';
import pipeline from './aparavi.pipe';

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
 * Top-level Aparavi AQL app component mounted by the shell.
 *
 * Initialises Documents with a VFS backed by the .chats/ workspace directory,
 * starts the Aparavi pipeline on connect, and creates an initial chat tab if
 * no saved chats exist.
 */
const AparaviApp: React.FC<ShellAppProps> = () => {
	// Shell connection — provides the RocketRide WebSocket client
	const { client, isConnected } = useShellConnection();

	// Auth identity — needed to confirm user is authenticated
	const identity = useAuthUser();

	// Workspace binding — persists tab layout across sessions
	const { loaded, appState, updateAppState } = useWorkspace();

	// Pipeline token from client.use() — shared across all chat tabs
	const [pipelineToken, setPipelineToken] = useState<string | null>(null);

	// Track pipeline startup to avoid duplicate .use() calls
	const startedRef = useRef(false);

	// Documents ready flag
	const [ready, setReady] = useState(false);

	// --- Initialise Documents on mount ---------------------------------------

	useEffect(() => {
		if (!client || !loaded) return;

		/** VFS backed by the .chats/ workspace directory. */
		const vfs: IVirtualFileSystem = {
			list: async (dir: string) => {
				try {
					const result = await listChatDir(client, dir);
					return (result.entries ?? []).map((e: any) => ({ name: e.name, type: e.type ?? 'file' }));
				} catch { return []; }
			},
			read: async (uri: string) => {
				try { return await loadChat(client, uri); }
				catch { return null; }
			},
			write: async (uri: string, content: unknown) => {
				if (!content) return;
				try { await saveChat(client, uri, content); }
				catch (err) { console.error('[AparaviApp] Failed to save chat:', err); }
			},
			rename: async (oldPath: string, newPath: string) => {
				await renameChat(client, oldPath, newPath);
			},
			delete: async (path: string) => {
				await deleteChat(client, path);
			},
		};

		// Create the Documents instance — both App and Sidebar share it
		createDocs(vfs, { appState, updateAppState });
		setReady(true);

		return () => { destroyDocs(); setReady(false); };
	}, [client, loaded]);

	// --- Start pipeline on connect -------------------------------------------

	useEffect(() => {
		if (!isConnected || !client || !identity || startedRef.current) return;
		startedRef.current = true;

		client
			.use({ pipeline, useExisting: true, name: 'Aparavi AQL Chat', pipelineTraceLevel: 'full' })
			.then((result) => {
				setPipelineToken(result.token);
			})
			.catch((err) => {
				startedRef.current = false;
				console.error('[AparaviApp] Failed to start pipeline:', err);
			});
	}, [isConnected, client, identity]);

	if (!ready) return <div style={styles.welcome}>Initialising...</div>;
	return <AparaviAppReady docs={getDocs()!} pipelineToken={pipelineToken} />;
};

// =============================================================================
// INNER COMPONENT — renders once Documents is ready
// =============================================================================

/**
 * Inner component that renders the tab layout and editor panes.
 * Separated so useStore() is called unconditionally.
 */
const AparaviAppReady: React.FC<{
	docs: Documents;
	pipelineToken: string | null;
}> = ({ docs, pipelineToken }) => {
	const state = docs.useStore();
	const { client, isConnected } = useShellConnection();

	// Whether there are multiple groups (controls close-group button visibility)
	const canCloseGroups = state.rootNode.type === 'split';

	// --- Ctrl+S handler -------------------------------------------------------

	useEffect(() => {
		/** Saves the active document on Ctrl+S. */
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

	return (
		<div style={styles.container}>
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;

					return (
						<div
							style={styles.groupPane}
							onClick={() => docs.setActiveGroup(groupId)}
						>
							{/* Tab bar for this group */}
							<DocTabs
								docs={docs}
								groupId={groupId}
								isActive={state.activeGroupId === groupId}
								canClose={canCloseGroups}
								onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)}
								onCloseGroup={(gid) => docs.closeGroup(gid)}
							/>

							{/* Editor content — each chat tab is independently mounted
							    so chat history is preserved across tab switches. */}
							<div style={styles.content}>
								{group.editorIds.length === 0 ? (
									<div style={styles.welcome}>
										<div style={{ fontSize: 16, fontWeight: 600 }}>Aparavi AQL</div>
										<div>Create a new chat from the sidebar.</div>
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
													flexDirection: 'column',
												}}
											>
												<ChatTab
													uri={editor.documentUri}
													client={client}
													isConnected={isConnected}
													pipelineToken={pipelineToken}
												/>
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
// CHAT TAB — independent persistent chat session per editor tab
// =============================================================================

/**
 * A single chat tab. Loads initial messages from the Document's content,
 * and persists messages back to Documents on every change so VFS auto-save
 * keeps the .chat file up to date.
 */
const ChatTab: React.FC<{
	uri: string;
	client: any;
	isConnected: boolean;
	pipelineToken: string | null;
}> = ({ uri, client, isConnected, pipelineToken }) => {
	// Read initial messages from the document content (if loaded from disk)
	const docs = getDocs();
	const savedMessages = useMemo<ChatMessage[]>(() => {
		if (!docs) return [];
		const doc = docs.getState().documents[uri];
		const content = doc?.content as { messages?: ChatMessage[] } | null;
		return content?.messages ?? [];
	}, [docs, uri]);

	const { messages, isTyping, sendMessage } = useChatMessages({
		initialMessages: savedMessages,
	});

	// Persist messages back to Documents + disk whenever they change
	const saveTimer = useRef<ReturnType<typeof setTimeout>>();
	useEffect(() => {
		if (!docs || messages.length === 0) return;
		// Only persist user and bot messages (not status/system ephemeral ones)
		const persistable = messages.filter((m) => m.sender === 'user' || m.sender === 'bot');
		if (persistable.length === 0) return;
		const content = { messages: persistable };
		docs.updateContent(uri, content);
		// Debounce the disk write to avoid excessive I/O on rapid message updates
		clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			if (client) saveChat(client, uri, content).catch((err) =>
				console.error('[AparaviApp] Failed to persist chat to disk:', err)
			);
		}, 500);
	}, [messages, uri, docs, client]);
	useEffect(() => () => clearTimeout(saveTimer.current), []);

	/** Send a message through the shared pipeline. */
	const handleSend = useCallback(
		(text: string) => {
			if (!client || !pipelineToken) return;
			sendMessage(text, client, pipelineToken);
		},
		[client, pipelineToken, sendMessage]
	);

	return (
		<ChatView
			messages={messages}
			isTyping={isTyping}
			isConnected={isConnected && !!pipelineToken}
			onSend={handleSend}
			placeholder="Ask about your Aparavi data..."
		/>
	);
};

export default AparaviApp;
