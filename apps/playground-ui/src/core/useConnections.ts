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
	/** Commits a conversation's row after its file was saved (skipped once a delete of it, or a removal of its connection begun after it, succeeds here). */
	commit: (meta: AgentSessionMeta) => Promise<void>;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Waits for a write, tells `report` whether it succeeded, and passes its
 * failure on.
 *
 * @param op - The write in flight.
 * @param report - Receives true on success, false on failure.
 */
async function reported(op: Promise<void>, report: (ok: boolean) => void): Promise<void> {
	try {
		await op;
	} catch (err) {
		report(false);
		throw err;
	}
	report(true);
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
	// Conversations deleted here, each with its delete's outcome (true once it
	// succeeded): a request that settles after its conversation was deleted
	// still saves, and its row must not bring the conversation back.
	const deleted = useRef(new Map<string, Promise<boolean>>());
	// Connections removed here, with when and the removal's outcome. A
	// conversation's row carries its creation time, so only rows of
	// conversations begun before the removal are held back, and opening the
	// same agent again is never blocked.
	const removed = useRef(new Map<string, { at: number; done: Promise<boolean> }>());

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
	const remove = useCallback(
		(id: string) => {
			let settle: (ok: boolean) => void = () => undefined;
			const removal = { at: Date.now(), done: new Promise<boolean>((resolve) => (settle = resolve)) };
			removed.current.set(id, removal);
			return write(() =>
				reported(removeConnection(id), (ok) => {
					// a failed removal leaves the connection, so its conversations commit again
					if (!ok && removed.current.get(id) === removal) removed.current.delete(id);
					settle(ok);
				})
			);
		},
		[write]
	);
	const deleteConversation = useCallback(
		(sessionId: string) => {
			let settle: (ok: boolean) => void = () => undefined;
			const done = new Promise<boolean>((resolve) => (settle = resolve));
			deleted.current.set(sessionId, done);
			return write(() =>
				reported(deleteStored(sessionId), (ok) => {
					// a failed delete leaves the conversation, so its saves commit again
					if (!ok && deleted.current.get(sessionId) === done) deleted.current.delete(sessionId);
					settle(ok);
				})
			);
		},
		[write]
	);
	const commit = useCallback(
		async (meta: AgentSessionMeta) => {
			// step: a delete or removal that covers this conversation is waited out: one that
			// succeeded keeps it gone, one that failed lets it commit. A conversation begun
			// after its connection's removal (the agent opened again) is not covered.
			for (;;) {
				const deletion = deleted.current.get(meta.sessionId);
				const removal = meta.group !== undefined ? removed.current.get(meta.group) : undefined;
				const pending = deletion ?? (removal && meta.date <= removal.at ? removal.done : undefined);
				if (!pending) break;
				if (await pending) return;
			}
			await write(() => commitConversation(meta));
		},
		[write]
	);

	return { tree, loading, error, refresh, openAgent, removeConnection: remove, deleteConversation, commit };
}
