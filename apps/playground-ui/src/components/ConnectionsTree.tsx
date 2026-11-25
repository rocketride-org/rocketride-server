// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionsTree — the sidebar: "+ New connection", then every agent the
 * caller has opened with its conversations under it, newest first. The rows
 * follow the Agent and Pipelines sidebar panels' anatomy (panelStyles: the
 * row, the 14px chevron slot, the child indent, the hover-revealed action);
 * the shell has no tree control.
 */

import React, { useState, type CSSProperties } from 'react';
import { BxChevronDown, BxChevronRight, BxPlus, BxTrash, BxX, ConfirmDialog, SidebarMenu, commonStyles } from 'shell';
import type { ViewMenu } from 'shell';
import { PANEL_HOVER_BG, panelStyles } from 'shared/tools/core/chrome/panelStyles';
import { AgentTile } from './AgentTile';
import { relativeDate } from '../core/friendly';
import type { ConnectionNode } from '../core/history';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	connection: {
		...panelStyles.row,
		gap: 7,
		padding: '4px 8px 4px 4px',
		lineHeight: '18px',
	} as CSSProperties,
	chevron: {
		width: 14,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	} as CSSProperties,
	connectionText: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	connectionName: {
		...commonStyles.textEllipsis,
		fontWeight: 600,
	} as CSSProperties,
	connectionNote: {
		...commonStyles.textEllipsis,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	conversation: {
		...panelStyles.row,
		alignItems: 'flex-start',
		padding: '3px 8px 3px 32px',
		lineHeight: '18px',
	} as CSSProperties,
	conversationText: {
		flex: 1,
		minWidth: 0,
		padding: '1px 0',
	} as CSSProperties,
	conversationTitle: {
		...commonStyles.textEllipsis,
		fontSize: 12.5,
	} as CSSProperties,
	conversationTitleNew: {
		...commonStyles.textEllipsis,
		fontSize: 12.5,
		fontStyle: 'italic',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	conversationDate: {
		fontSize: 11,
		lineHeight: '14px',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	// The open row, as the Agent sidebar panel marks its open session.
	selected: {
		background: PANEL_HOVER_BG,
		fontWeight: 600,
	} as CSSProperties,
	hovered: {
		background: PANEL_HOVER_BG,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** What is open on the right. */
export interface TreeSelection {
	/** The open connection, or null for the picker. */
	connectionId: string | null;
	/** The open conversation, or null for a new one. */
	sessionId: string | null;
}

/** Props for {@link ConnectionsTree}. */
export interface IConnectionsTreeProps {
	/** Every connection with its conversations. */
	tree: ConnectionNode[];
	/** What is open. */
	selected: TreeSelection;
	/** Connections whose agent works on its own (no conversations, never sent to). */
	onItsOwn: ReadonlySet<string>;
	/** Which connections are expanded (the open one always is). */
	expanded: Readonly<Record<string, boolean>>;
	/** Flips a connection's expanded state. */
	onToggle: (connectionId: string) => void;
	/** Opens the picker. */
	onNewConnection: () => void;
	/** Opens a connection (its newest conversation, or a new one). */
	onOpenConnection: (connectionId: string) => void;
	/** Opens one conversation. */
	onOpenConversation: (connectionId: string, sessionId: string) => void;
	/** Removes a connection with its conversations (already confirmed). */
	onRemoveConnection: (connectionId: string) => void;
	/** Deletes one conversation. */
	onDeleteConversation: (sessionId: string) => void;
	/** Where the tree could not be read, if it could not. */
	error?: string | null;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the connections tree.
 *
 * @param props - {@link IConnectionsTreeProps}.
 * @returns The sidebar body.
 */
export const ConnectionsTree: React.FC<IConnectionsTreeProps> = ({ tree, selected, onItsOwn, expanded, onToggle, onNewConnection, onOpenConnection, onOpenConversation, onRemoveConnection, onDeleteConversation, error }) => {
	const [hovered, setHovered] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<ConnectionNode | null>(null);

	const navMenu: ViewMenu = { entries: [{ id: 'newConnection', label: 'New connection', icon: <BxPlus size={16} /> }] };

	// A selected connection with no conversation open has a New conversation row.
	const openIsNew = selected.connectionId !== null && selected.sessionId === null;
	const selectedIsListed = tree.some((n) => n.group.id === selected.connectionId);

	return (
		<div style={panelStyles.panelColumn}>
			<div style={panelStyles.navSection}>
				<SidebarMenu menu={navMenu} activeId={selected.connectionId === null ? 'newConnection' : ''} onSelect={() => onNewConnection()} />
			</div>
			<div style={panelStyles.sectionLabel}>Connections</div>
			<div style={panelStyles.sectionList}>
				{error && <div style={panelStyles.emptyLine}>{error}</div>}
				{tree.length === 0 && !selectedIsListed && <div style={panelStyles.emptyLine}>No connections yet — open an agent with New connection.</div>}
				{tree.map((node) => {
					const id = node.group.id;
					const isOpen = id === selected.connectionId;
					const itsOwn = onItsOwn.has(id);
					const showNew = isOpen && openIsNew && !itsOwn;
					const hasChildren = node.conversations.length > 0 || showNew;
					const isExpanded = isOpen || !!expanded[id];
					const rowKey = `c:${id}`;
					return (
						<React.Fragment key={id}>
							<div
								role="button"
								tabIndex={0}
								title={id}
								style={{ ...styles.connection, ...(isOpen && (itsOwn || !hasChildren) ? styles.selected : hovered === rowKey ? styles.hovered : {}) }}
								onMouseEnter={() => setHovered(rowKey)}
								onMouseLeave={() => setHovered(null)}
								onClick={() => (isOpen ? onToggle(id) : onOpenConnection(id))}
								onKeyDown={(e) => {
									if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
									e.preventDefault();
									onOpenConnection(id);
								}}
							>
								<span
									style={styles.chevron}
									onClick={(e) => {
										e.stopPropagation();
										if (hasChildren) onToggle(id);
									}}
								>
									{hasChildren ? isExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} /> : null}
								</span>
								<AgentTile name={node.group.title} icon={node.group.icon} size="s" />
								<div style={styles.connectionText}>
									<div style={styles.connectionName}>{node.group.title}</div>
									{itsOwn && <div style={styles.connectionNote}>Runs on its own</div>}
								</div>
								{/* The hover action is a bare icon in the sibling panels' anatomy (panelStyles.actionBtn); the shell has no icon-button control. */}
								<button
									style={panelStyles.actionBtn('var(--rr-text-secondary)')}
									title="Remove connection"
									onClick={(e) => {
										e.stopPropagation();
										setConfirming(node);
									}}
								>
									<BxX size={14} />
								</button>
							</div>
							{isExpanded && showNew && (
								<div style={{ ...styles.conversation, ...styles.selected }}>
									<div style={styles.conversationText}>
										<div style={styles.conversationTitleNew}>New conversation</div>
									</div>
								</div>
							)}
							{isExpanded &&
								node.conversations.map((meta) => {
									const convKey = `s:${meta.sessionId}`;
									const active = isOpen && selected.sessionId === meta.sessionId;
									return (
										<div
											key={meta.sessionId}
											role="button"
											tabIndex={0}
											title={meta.title}
											style={{ ...styles.conversation, ...(active ? styles.selected : hovered === convKey ? styles.hovered : {}) }}
											onMouseEnter={() => setHovered(convKey)}
											onMouseLeave={() => setHovered(null)}
											onFocus={() => setHovered(convKey)}
											onClick={() => onOpenConversation(id, meta.sessionId)}
											onKeyDown={(e) => {
												if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
												e.preventDefault();
												onOpenConversation(id, meta.sessionId);
											}}
										>
											<div style={styles.conversationText}>
												<div style={styles.conversationTitle}>{meta.title}</div>
												<div style={styles.conversationDate}>{relativeDate(meta.date)}</div>
											</div>
											{hovered === convKey && (
												<button
													style={panelStyles.actionBtn('var(--rr-text-secondary)')}
													title="Delete conversation"
													onClick={(e) => {
														e.stopPropagation();
														onDeleteConversation(meta.sessionId);
													}}
												>
													<BxTrash size={14} />
												</button>
											)}
										</div>
									);
								})}
						</React.Fragment>
					);
				})}
			</div>
			{confirming && (
				<ConfirmDialog
					title={`Remove ${confirming.group.title}?`}
					message={confirming.conversations.length === 0 ? 'It leaves your connections.' : `Its ${confirming.conversations.length === 1 ? 'conversation is' : `${confirming.conversations.length} conversations are`} deleted too.`}
					confirmLabel="Remove"
					destructive
					onConfirm={() => {
						onRemoveConnection(confirming.group.id);
						setConfirming(null);
					}}
					onCancel={() => setConfirming(null)}
				/>
			)}
		</div>
	);
};
