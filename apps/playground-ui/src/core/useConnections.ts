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

/** One delete or removal in flight: when it began, and whether it succeeded. */
interface Attempt {
	/** Epoch ms it began. */
	at: number;
	/** Settles true on success, false on failure; never rejects. */
	done: Promise<boolean>;
}

/**
 * Runs one delete or removal as a pending attempt under `key`. When it
 * settles it leaves the pending set and, on success, `succeeded` records it,
 * both before anything waiting on `done` resumes. A failure removes only this
 * attempt and is passed on.
 *
 * @param pending - The attempts in flight, by key.
 * @param key - The conversation's or connection's id.
 * @param op - The delete or removal.
 * @param succeeded - Records a success, given the attempt's start time.
 */
async function track(pending: Map<string, Set<Attempt>>, key: string, op: () => Promise<void>, succeeded: (at: number) => void): Promise<void> {
	let settle: (ok: boolean) => void = () => undefined;
	const attempt: Attempt = { at: Date.now(), done: new Promise<boolean>((resolve) => (settle = resolve)) };
	const set = pending.get(key) ?? new Set<Attempt>();
	set.add(attempt);
	pending.set(key, set);
	let ok = false;
	try {
		await op();
		ok = true;
	} finally {
		set.delete(attempt);
		if (set.size === 0) pending.delete(key);
		if (ok) succeeded(attempt.at);
		settle(ok);
	}
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
	// A request that settles after its conversation was deleted, or its
	// connection removed, still saves; its row must not bring either back.
	// Successes are kept apart from attempts in flight, so a later attempt that
	// fails never clears an earlier success.
	// Conversations deleted here for good, and deletes in flight by conversation.
	const deleted = useRef(new Set<string>());
	const deleting = useRef(new Map<string, Set<Attempt>>());
	// Per connection, the start time of its latest successful removal here, and
	// removals in flight. A row carries its conversation's creation time: one
	// begun at or before a removal is covered by it; one begun after (the agent
	// opened again) is not, so a reopen is never blocked by an older removal.
	const removedAt = useRef(new Map<string, number>());
	const removing = useRef(new Map<string, Set<Attempt>>());

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
		(id: string) =>
			write(() =>
				track(removing.current, id, () => removeConnection(id), (at) => {
					removedAt.current.set(id, Math.max(removedAt.current.get(id) ?? at, at));
				})
			),
		[write]
	);
	const deleteConversation = useCallback(
		(sessionId: string) =>
			write(() =>
				track(deleting.current, sessionId, () => deleteStored(sessionId), () => {
					deleted.current.add(sessionId);
				})
			),
		[write]
	);
	const commit = useCallback(
		async (meta: AgentSessionMeta) => {
			// step: a recorded success rejects the row; otherwise every delete or removal in
			// flight that covers it is waited out and all is checked again, so a failed
			// attempt lets the row through and one that succeeded keeps it out
			for (;;) {
				if (deleted.current.has(meta.sessionId)) return;
				const removedTime = meta.group !== undefined ? removedAt.current.get(meta.group) : undefined;
				if (removedTime !== undefined && meta.date <= removedTime) return;
				const removals = meta.group !== undefined ? [...(removing.current.get(meta.group) ?? [])].filter((r) => meta.date <= r.at) : [];
				const covering = [...(deleting.current.get(meta.sessionId) ?? []), ...removals];
				if (covering.length === 0) break;
				await Promise.all(covering.map((a) => a.done));
			}
			await write(() => commitConversation(meta));
		},
		[write]
	);

	return { tree, loading, error, refresh, openAgent, removeConnection: remove, deleteConversation, commit };
}
