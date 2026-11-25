// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The connections tree and its writes — the catalog's ONE writer. The
 * browser app mounts it once; in a dev tool host the sidebar (the tool's
 * controller) mounts it, and frames hand it their conversations' rows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { commitConversation, deleteConversation as deleteStored, loadTree, removeConnection, saveConnection } from './history';
import type { AgentSessionMeta, ConnectionNode } from './history';
import { failureOf } from './send';

// =============================================================================
// TYPES
// =============================================================================

/** What opening an agent records about it. */
export interface ConnectionLabel {
	/** The agent's name. */
	name: string;
	/** Its icon URL. */
	icon?: string;
}

/** The tree and its actions. */
export interface ConnectionsApi {
	/** Every connection with its conversations, newest activity first. */
	tree: ConnectionNode[];
	/** True until the first read settles. */
	loading: boolean;
	/** Why the last read or write failed, if it did. */
	error: string | null;
	/** Re-reads the tree. */
	refresh: () => Promise<void>;
	/** Adds (or touches) a connection. */
	openAgent: (address: string, label: ConnectionLabel) => Promise<void>;
	/** Removes a connection with every conversation in it. */
	removeConnection: (id: string) => Promise<void>;
	/** Deletes one conversation. */
	deleteConversation: (sessionId: string) => Promise<void>;
	/** Commits a conversation's row after its file was saved (skipped for one deleted here). */
	commit: (meta: AgentSessionMeta) => Promise<void>;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Loads the tree once connected and re-reads it after every write (the store
 * queues the writes themselves); when reads overlap, only the newest one
 * started sets the tree.
 *
 * @param connected - Whether the realm's client is connected.
 * @returns {@link ConnectionsApi}.
 */
export function useConnections(connected: boolean): ConnectionsApi {
	const [tree, setTree] = useState<ConnectionNode[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);
	// Each read's ticket: an older read that resolves late never replaces a newer tree.
	const readSeq = useRef(0);
	// Conversations deleted here: a request that settles after its conversation
	// was deleted still saves, and its row must not bring the conversation back.
	const deleted = useRef(new Set<string>());

	// Set on every setup, not only at creation: StrictMode runs the cleanup and the setup again.
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = useCallback(async () => {
		const seq = ++readSeq.current;
		try {
			const next = await loadTree();
			if (!mounted.current || seq !== readSeq.current) return;
			setTree(next);
			setError(null);
		} catch (err) {
			if (mounted.current && seq === readSeq.current) setError(failureOf(err).message);
		} finally {
			if (mounted.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (connected) void refresh();
	}, [connected, refresh]);

	/** Runs one write, then re-reads the tree; a failure is set after the re-read, so the view keeps it. */
	const write = useCallback(
		async (op: () => Promise<void>) => {
			let failure: string | null = null;
			try {
				await op();
			} catch (err) {
				failure = failureOf(err).message;
			}
			await refresh();
			if (failure && mounted.current) setError(failure);
		},
		[refresh]
	);

	const openAgent = useCallback((address: string, label: ConnectionLabel) => write(() => saveConnection({ id: address, title: label.name, ...(label.icon ? { icon: label.icon } : {}), date: Date.now() })), [write]);
	const remove = useCallback((id: string) => write(() => removeConnection(id)), [write]);
	const deleteConversation = useCallback(
		(sessionId: string) => {
			deleted.current.add(sessionId);
			return write(() => deleteStored(sessionId));
		},
		[write]
	);
	const commit = useCallback((meta: AgentSessionMeta) => (deleted.current.has(meta.sessionId) ? Promise.resolve() : write(() => commitConversation(meta))), [write]);

	return { tree, loading, error, refresh, openAgent, removeConnection: remove, deleteConversation, commit };
}
