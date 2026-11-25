// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The dev tool, in Rocket Builder and VS Code. Two mounts, which may live in
 * separate webviews and talk only over the tool channel:
 *   - the SIDEBAR (the controller) draws the connections tree and owns the
 *     history catalog: frames send it their saved conversations' rows;
 *   - each FRAME is one connection's tab (docKey = the agent's address), or
 *     the picker tab (docKey = PICK_KEY) on hosts with documents.
 *
 * Channel events (names and payloads):
 *   sidebar → frames  'open'   {connectionId, sessionId}   show a conversation (null = new)
 *   sidebar → frames  'pick'   {}                          show the picker (single-frame hosts)
 *   frame → sidebar   'saved'  AgentSessionMeta            commit a conversation's row
 *   frame → sidebar   'agent'  {connectionId, name, icon, onItsOwn}
 *   frame → sidebar   'chose'  {address, name}             open a connection
 *   frame → sidebar   'active' {connectionId, sessionId}   what the frame shows
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DevToolProps } from 'shell';
import { useShellConnection } from 'shell';
import { AgentPicker } from './components/AgentPicker';
import { ConnectionsTree } from './components/ConnectionsTree';
import { ConversationPane } from './components/ConversationPane';
import type { AgentSessionMeta } from './core/history';
import type { AgentInfo } from './core/model';
import { useSelection, useViewChoice } from './core/selection';
import { useConnections } from './core/useConnections';

// =============================================================================
// PROTOCOL
// =============================================================================

/** The picker tab's document key. */
export const PICK_KEY = 'playground:new-connection';

/** 'open' payload. */
interface OpenEvent {
	connectionId: string;
	sessionId: string | null;
}

/** 'agent' payload. */
interface AgentEvent {
	connectionId: string;
	name: string;
	icon?: string;
	onItsOwn: boolean;
}

/** 'chose' payload. */
interface ChoseEvent {
	address: string;
	name: string;
}

/** 'active' payload. */
interface ActiveEvent {
	connectionId: string;
	sessionId: string | null;
}

// =============================================================================
// SIDEBAR — the controller
// =============================================================================

/**
 * The connections tree in the host's sidebar; the history catalog's writer.
 *
 * @param props - {@link DevToolProps}.
 * @returns The sidebar.
 */
export const PlaygroundDevToolSidebar: React.FC<DevToolProps> = ({ channel, documents, activeDocKey }) => {
	const { isConnected } = useShellConnection();
	const connections = useConnections(isConnected);
	const [active, setActive] = useState<ActiveEvent | null>(null);
	// The conversation each connection's tab shows, so fronting a tab again marks its own.
	const [shownSessions, setShownSessions] = useState<Readonly<Record<string, string | null>>>({});
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [onItsOwn, setOnItsOwn] = useState<ReadonlySet<string>>(new Set());
	const { tree, commit, openAgent } = connections;
	// The tree as of the latest render, for handlers subscribed once.
	const treeRef = useRef(tree);
	treeRef.current = tree;

	/** Records what a frame shows: the latest move, and that connection's conversation. */
	const markActive = useCallback((event: ActiveEvent) => {
		setActive(event);
		setShownSessions((cur) => ({ ...cur, [event.connectionId]: event.sessionId }));
	}, []);

	// ── Frames → controller ───────────────────────────────────────────────
	useEffect(() => {
		const offs = [
			channel.onEvent('saved', (payload) => {
				const meta = payload as AgentSessionMeta;
				if (meta?.sessionId) void commit(meta);
			}),
			channel.onEvent('active', (payload) => {
				const p = payload as ActiveEvent;
				if (p?.connectionId) markActive(p);
			}),
			channel.onEvent('agent', (payload) => {
				const p = payload as AgentEvent;
				if (!p?.connectionId) return;
				setOnItsOwn((cur) => {
					if (cur.has(p.connectionId) === p.onItsOwn) return cur;
					const next = new Set(cur);
					if (p.onItsOwn) next.add(p.connectionId);
					else next.delete(p.connectionId);
					return next;
				});
				const node = treeRef.current.find((n) => n.group.id === p.connectionId);
				if (!node || node.group.title !== p.name || node.group.icon !== p.icon) void openAgent(p.connectionId, { name: p.name, icon: p.icon });
			}),
			channel.onEvent('chose', (payload) => {
				const p = payload as ChoseEvent;
				if (!p?.address) return;
				void openAgent(p.address, { name: p.name });
				documents?.open(p.address, p.name);
				channel.sendEvent('open', { connectionId: p.address, sessionId: null } satisfies OpenEvent);
				markActive({ connectionId: p.address, sessionId: null });
			}),
		];
		return () => offs.forEach((off) => off());
	}, [channel, commit, documents, markActive, openAgent]);

	// ── The sidebar's moves (each in response to a click) ─────────────────
	const openIn = useCallback(
		(connectionId: string, sessionId: string | null) => {
			const name = tree.find((n) => n.group.id === connectionId)?.group.title ?? connectionId;
			documents?.open(connectionId, name);
			channel.sendEvent('open', { connectionId, sessionId } satisfies OpenEvent);
			markActive({ connectionId, sessionId });
		},
		[channel, documents, markActive, tree]
	);

	// The fronted tab decides which connection is highlighted, when the host says.
	const shownConnection = activeDocKey !== undefined ? (activeDocKey && activeDocKey !== PICK_KEY ? activeDocKey : null) : (active?.connectionId ?? null);

	return (
		<ConnectionsTree
			tree={tree}
			selected={{ connectionId: shownConnection, sessionId: shownConnection ? (shownSessions[shownConnection] ?? null) : null }}
			onItsOwn={onItsOwn}
			expanded={expanded}
			error={connections.error}
			onToggle={(id) => setExpanded((cur) => ({ ...cur, [id]: !cur[id] }))}
			onNewConnection={() => {
				documents?.open(PICK_KEY, 'New connection');
				channel.sendEvent('pick', {});
			}}
			onOpenConnection={(id) => openIn(id, tree.find((n) => n.group.id === id)?.conversations[0]?.sessionId ?? null)}
			onOpenConversation={(id, sessionId) => openIn(id, sessionId)}
			onRemoveConnection={(id) => {
				documents?.close(id);
				void connections.removeConnection(id);
			}}
			onDeleteConversation={(sessionId) => {
				void connections.deleteConversation(sessionId);
				// step: the tab showing it (by what each tab shows, not the last move) starts a new conversation
				const showing = Object.keys(shownSessions).find((id) => shownSessions[id] === sessionId);
				if (showing) {
					channel.sendEvent('open', { connectionId: showing, sessionId: null } satisfies OpenEvent);
					markActive({ connectionId: showing, sessionId: null });
				}
			}}
		/>
	);
};

// =============================================================================
// FRAME — one connection's tab, or the picker
// =============================================================================

/**
 * One tab: the connection its docKey names (or, on single-frame hosts, the
 * one the sidebar last opened), or the picker.
 *
 * @param props - {@link DevToolProps}.
 * @returns The frame.
 */
export const PlaygroundDevTool: React.FC<DevToolProps> = ({ channel, documents, docKey }) => {
	const { simple, toggle } = useViewChoice('advanced');
	const bound = docKey && docKey !== PICK_KEY ? docKey : null;
	const { selection, open, startNew } = useSelection(bound);

	// ── Controller → this frame ───────────────────────────────────────────
	useEffect(() => {
		const offs = [
			channel.onEvent('open', (payload) => {
				const p = payload as OpenEvent;
				if (!p?.connectionId) return;
				// A tab follows only its own connection (the picker tab, bound to none,
				// follows none); a single frame, with no document key, follows every open.
				if (docKey && p.connectionId !== bound) return;
				if (p.sessionId === null) startNew(p.connectionId);
				else open(p.connectionId, p.sessionId);
			}),
			channel.onEvent('pick', () => {
				if (!documents) open(null, null);
			}),
		];
		return () => offs.forEach((off) => off());
	}, [bound, channel, docKey, documents, open, startNew]);

	// ── This frame → controller ───────────────────────────────────────────
	const handleSaved = useCallback(
		(meta: AgentSessionMeta, current: boolean) => {
			channel.sendEvent('saved', meta);
			// A pane that closed before its request settled never moves the sidebar's selection.
			if (current && selection.connectionId) channel.sendEvent('active', { connectionId: selection.connectionId, sessionId: meta.sessionId } satisfies ActiveEvent);
		},
		[channel, selection.connectionId]
	);

	const handleAgentRead = useCallback(
		(agent: AgentInfo) => {
			if (!selection.connectionId) return;
			const onItsOwnHere = !(agent.source?.kind === 'request' && agent.source.entry === 'data');
			channel.sendEvent('agent', { connectionId: selection.connectionId, name: agent.listing.name, icon: agent.listing.icon, onItsOwn: onItsOwnHere } satisfies AgentEvent);
		},
		[channel, selection.connectionId]
	);

	const choose = useCallback(
		(address: string, name: string) => {
			channel.sendEvent('chose', { address, name } satisfies ChoseEvent);
			// A single-frame host has no tabs to open: this frame becomes the connection.
			if (!documents) startNew(address);
		},
		[channel, documents, startNew]
	);

	if (!selection.connectionId) return <AgentPicker simple={simple} writeLink={false} onChoose={choose} />;
	return (
		<ConversationPane
			key={`${selection.connectionId}|${selection.sessionId ?? 'new'}|${selection.fresh}`}
			connectionId={selection.connectionId}
			sessionId={selection.sessionId}
			simple={simple}
			onToggleView={toggle}
			onSaved={handleSaved}
			onNewConversation={() => {
				startNew(selection.connectionId!);
				channel.sendEvent('active', { connectionId: selection.connectionId!, sessionId: null } satisfies ActiveEvent);
			}}
			onChooseAnother={() => (documents ? documents.open(PICK_KEY, 'New connection') : open(null, null))}
			onUseSource={choose}
			onAgentRead={handleAgentRead}
		/>
	);
};
