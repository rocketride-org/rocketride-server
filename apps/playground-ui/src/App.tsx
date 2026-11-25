// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The browser app: the connections tree in the shell's sidebar, the open
 * conversation (or the picker) on the right. Opened by an agent tile or a
 * link (`?pipe=<address>`), Simple by default. This one mount owns the
 * history catalog.
 */

import React, { useCallback, useState } from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout, useShellConnection } from 'shell';
import { pipeLinkFromLocation } from 'shared/components/pipe-picker';
import { AgentPicker } from './components/AgentPicker';
import { ConnectionsTree } from './components/ConnectionsTree';
import { ConversationPane } from './components/ConversationPane';
import type { AgentSessionMeta } from './core/history';
import type { AgentInfo } from './core/model';
import { useSelection, useViewChoice } from './core/selection';
import { useConnections } from './core/useConnections';

// =============================================================================
// APP
// =============================================================================

/**
 * Root view.
 *
 * @param _props - The shell's app props.
 * @returns The app.
 */
const App: React.FC<ShellAppProps> = () => {
	const { isConnected } = useShellConnection();
	const connections = useConnections(isConnected);
	const { simple, toggle } = useViewChoice('simple');
	const { selection, open, startNew } = useSelection(pipeLinkFromLocation()?.pipe ?? null);
	const [activeSession, setActiveSession] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [onItsOwn, setOnItsOwn] = useState<ReadonlySet<string>>(new Set());

	// ── Moves ─────────────────────────────────────────────────────────────

	const openConversation = useCallback(
		(connectionId: string, sessionId: string) => {
			if (connectionId === selection.connectionId && sessionId === activeSession) return;
			setActiveSession(sessionId);
			open(connectionId, sessionId);
		},
		[activeSession, open, selection.connectionId]
	);

	const openConnection = useCallback(
		(connectionId: string) => {
			const node = connections.tree.find((n) => n.group.id === connectionId);
			const newest = node?.conversations[0]?.sessionId ?? null;
			setActiveSession(newest);
			open(connectionId, newest);
		},
		[connections.tree, open]
	);

	const newConversation = useCallback(() => {
		if (!selection.connectionId) return;
		setActiveSession(null);
		startNew(selection.connectionId);
	}, [selection.connectionId, startNew]);

	// ── Writes ────────────────────────────────────────────────────────────

	const handleSaved = useCallback(
		(meta: AgentSessionMeta, current: boolean) => {
			// A pane that closed before its request settled still commits its row, but never moves the selection.
			if (current) setActiveSession(meta.sessionId);
			void connections.commit(meta);
		},
		[connections]
	);

	const handleAgentRead = useCallback(
		(agent: AgentInfo) => {
			const id = selection.connectionId;
			if (!id) return;
			const itsOwn = !(agent.source?.kind === 'request' && agent.source.entry === 'data');
			setOnItsOwn((cur) => {
				if (cur.has(id) === itsOwn) return cur;
				const next = new Set(cur);
				if (itsOwn) next.add(id);
				else next.delete(id);
				return next;
			});
			// step: an agent opened from a tile or a link becomes a connection, named as listed
			const node = connections.tree.find((n) => n.group.id === id);
			if (!node || node.group.title !== agent.listing.name || node.group.icon !== agent.listing.icon) void connections.openAgent(id, { name: agent.listing.name, icon: agent.listing.icon });
		},
		[connections, selection.connectionId]
	);

	// ── View ──────────────────────────────────────────────────────────────

	const sidebar = (
		<ConnectionsTree
			tree={connections.tree}
			selected={{ connectionId: selection.connectionId, sessionId: activeSession }}
			onItsOwn={onItsOwn}
			expanded={expanded}
			error={connections.error}
			onToggle={(id) => setExpanded((cur) => ({ ...cur, [id]: !cur[id] }))}
			onNewConnection={() => open(null, null)}
			onOpenConnection={openConnection}
			onOpenConversation={openConversation}
			onRemoveConnection={(id) => {
				if (id === selection.connectionId) open(null, null);
				void connections.removeConnection(id);
			}}
			onDeleteConversation={(sessionId) => {
				if (sessionId === activeSession && selection.connectionId) newConversation();
				void connections.deleteConversation(sessionId);
			}}
		/>
	);

	return (
		<AppLayout sidebar={sidebar} showStatus>
			{selection.connectionId ? (
				<ConversationPane
					key={`${selection.connectionId}|${selection.sessionId ?? 'new'}|${selection.fresh}`}
					connectionId={selection.connectionId}
					sessionId={selection.sessionId}
					simple={simple}
					onToggleView={toggle}
					onSaved={handleSaved}
					onNewConversation={newConversation}
					onChooseAnother={() => open(null, null)}
					onUseSource={(address) => {
						setActiveSession(null);
						open(address, null);
					}}
					onAgentRead={handleAgentRead}
				/>
			) : (
				<AgentPicker
					simple={simple}
					writeLink
					onChoose={(address) => {
						setActiveSession(null);
						open(address, null);
					}}
				/>
			)}
		</AppLayout>
	);
};

export default App;
