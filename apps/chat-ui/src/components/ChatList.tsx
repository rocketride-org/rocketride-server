/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Pencil, Trash2, Plus } from 'lucide-react';
import type { ChatCatalogEntry, RocketRideClient } from 'rocketride';

interface ChatListProps {
	client: RocketRideClient;
	pipelineId: string;
	currentChatId: string | null;
	onSelectChat: (chatId: string) => void;
	onNewChat: () => void;
	onDeleteChat: (chatId: string) => Promise<void>;
	onRenameChat: (chatId: string, title: string) => Promise<void>;
	/** Bumped by ChatContainer when a turn is persisted so the list refreshes. */
	refreshKey: number;
}

/**
 * Sidebar list of the user's persisted chats for the current pipeline.
 *
 * Calls ``client.chats.list({pipelineId})`` on mount and whenever ``refreshKey``
 * changes — the parent bumps the key after sending a message, renaming, or
 * deleting so the rendered list stays in sync with the on-disk catalog.
 */
export const ChatList: React.FC<ChatListProps> = ({ client, pipelineId, currentChatId, onSelectChat, onNewChat, onDeleteChat, onRenameChat, refreshKey }) => {
	const [entries, setEntries] = useState<ChatCatalogEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState('');
	// Two-stage delete: first trash click arms the row, second click commits.
	// Native window.confirm() is silently dropped inside this VS Code webview
	// because the iframe sandbox omits `allow-modals`.
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

	const loadEntries = useCallback(async () => {
		setLoading(true);
		try {
			const list = await client.chats.list({ pipelineId });
			// Newest first.
			list.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
			setEntries(list);
		} catch (err) {
			console.warn('ChatList: failed to load catalog', err);
			setEntries([]);
		} finally {
			setLoading(false);
		}
	}, [client, pipelineId]);

	useEffect(() => {
		void loadEntries();
	}, [loadEntries, refreshKey]);

	const handleStartRename = (entry: ChatCatalogEntry) => {
		setEditingId(entry.guid);
		setEditingTitle(entry.title);
	};

	const handleCommitRename = async (entry: ChatCatalogEntry) => {
		const next = editingTitle.trim() || 'Untitled chat';
		setEditingId(null);
		setEditingTitle('');
		if (next !== entry.title) {
			await onRenameChat(entry.guid, next);
			void loadEntries();
		}
	};

	const handleDeleteClick = async (entry: ChatCatalogEntry) => {
		if (pendingDeleteId === entry.guid) {
			setPendingDeleteId(null);
			await onDeleteChat(entry.guid);
			void loadEntries();
		} else {
			setPendingDeleteId(entry.guid);
			// Auto-disarm after 3s if user doesn't confirm.
			window.setTimeout(() => {
				setPendingDeleteId((current) => (current === entry.guid ? null : current));
			}, 3000);
		}
	};

	return (
		<aside
			style={{
				width: '240px',
				borderRight: '1px solid var(--border-color)',
				background: 'var(--bg-secondary)',
				color: 'var(--text-primary)',
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
				overflow: 'hidden',
			}}
		>
			<div style={{ padding: '12px', borderBottom: '1px solid var(--border-color)' }}>
				<button
					type="button"
					onClick={onNewChat}
					style={{
						width: '100%',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						gap: '6px',
						padding: '8px 12px',
						background: 'var(--accent-primary)',
						color: '#ffffff',
						border: 'none',
						borderRadius: '6px',
						cursor: 'pointer',
						fontSize: '0.875rem',
						fontWeight: 500,
					}}
					aria-label="New chat"
				>
					<Plus className="w-4 h-4" />
					New chat
				</button>
			</div>
			<div style={{ flex: 1, overflowY: 'auto' }}>
				{loading && entries.length === 0 ? (
					<div style={{ padding: '12px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Loading…</div>
				) : entries.length === 0 ? (
					<div style={{ padding: '12px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No saved chats yet. Send a message to start one.</div>
				) : (
					entries.map((entry) => {
						const isActive = entry.guid === currentChatId;
						const isEditing = editingId === entry.guid;
						return (
							<div
								key={entry.guid}
								role="button"
								tabIndex={isEditing ? -1 : 0}
								aria-current={isActive ? 'true' : undefined}
								onClick={() => !isEditing && onSelectChat(entry.guid)}
								onKeyDown={(e) => {
									if (isEditing) return;
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										onSelectChat(entry.guid);
									}
								}}
								style={{
									padding: '10px 12px',
									cursor: isEditing ? 'default' : 'pointer',
									borderBottom: '1px solid var(--border-color)',
									background: isActive ? 'var(--bg-tertiary)' : 'transparent',
									color: 'var(--text-primary)',
								}}
							>
								{isEditing ? (
									<input
										type="text"
										value={editingTitle}
										onChange={(e) => setEditingTitle(e.target.value)}
										onBlur={() => void handleCommitRename(entry)}
										onKeyDown={(e) => {
											if (e.key === 'Enter') {
												void handleCommitRename(entry);
											} else if (e.key === 'Escape') {
												setEditingId(null);
												setEditingTitle('');
											}
										}}
										autoFocus
										style={{
											width: '100%',
											padding: '4px 6px',
											fontSize: '0.875rem',
											background: 'var(--input-bg, var(--bg-primary))',
											color: 'var(--text-primary)',
											border: '1px solid var(--input-border, var(--border-color))',
											borderRadius: '4px',
											outline: 'none',
										}}
									/>
								) : (
									<>
										<div
											style={{
												display: 'flex',
												justifyContent: 'space-between',
												alignItems: 'center',
												gap: '6px',
											}}
										>
											<div style={{ fontWeight: 500, fontSize: '0.875rem', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title || 'Untitled chat'}</div>
											<div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														handleStartRename(entry);
													}}
													style={{
														background: 'transparent',
														border: 'none',
														cursor: 'pointer',
														padding: '2px',
														color: 'var(--text-secondary)',
													}}
													aria-label={`Rename ${entry.title}`}
													title="Rename"
												>
													<Pencil className="w-3 h-3" />
												</button>
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														void handleDeleteClick(entry);
													}}
													style={{
														background: pendingDeleteId === entry.guid ? 'var(--error-color)' : 'transparent',
														border: 'none',
														cursor: 'pointer',
														padding: '2px',
														borderRadius: '4px',
														color: pendingDeleteId === entry.guid ? '#ffffff' : 'var(--text-secondary)',
													}}
													aria-label={pendingDeleteId === entry.guid ? `Confirm delete ${entry.title}` : `Delete ${entry.title}`}
													title={pendingDeleteId === entry.guid ? 'Click again to confirm' : 'Delete'}
												>
													<Trash2 className="w-3 h-3" />
												</button>
											</div>
										</div>
										{entry.preview && (
											<div
												style={{
													marginTop: '2px',
													fontSize: '0.75rem',
													color: 'var(--text-secondary)',
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap',
												}}
											>
												{entry.preview}
											</div>
										)}
									</>
								)}
							</div>
						);
					})
				)}
			</div>
		</aside>
	);
};
