// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The Playground's history, kept in the shared agent session store (the one
 * rocket-ui's Agent tool keeps its sessions in) under the Playground's own
 * app id: `.agents/rocketride.playground/catalog.json` and one
 * `<sessionId>.json` per conversation. A CONNECTION is a group (its id is
 * the agent's address as opened); a CONVERSATION is a session in it.
 */

import { AgentSession } from 'shared/modules/agent/agent';
import type { AgentSessionGroup, AgentSessionMeta } from 'shared/modules/agent/agent';

// =============================================================================
// TYPES
// =============================================================================

/** One connection with its conversations, newest first. */
export interface ConnectionNode {
	/** The group row: id = the agent's address, title = its name, icon = its icon URL. */
	group: AgentSessionGroup;
	/** Its conversations, newest first. */
	conversations: AgentSessionMeta[];
	/** Epoch ms of its newest activity (its newest conversation, else when it was opened). */
	activity: number;
}

export type { AgentSessionGroup, AgentSessionMeta };

// =============================================================================
// CONSTANTS
// =============================================================================

/** The app id that namespaces the Playground's history. */
export const HISTORY_APP_ID = 'rocketride.playground';

/** The most conversations the tree reads at once. */
const TREE_LIMIT = 2000;

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Whether this realm has stamped the store's app id. */
let configured = false;

/** Stamps the store's app id once per realm. */
export function configureHistory(): void {
	if (configured) return;
	AgentSession.configure(HISTORY_APP_ID);
	configured = true;
}

// =============================================================================
// TREE
// =============================================================================

/**
 * Every connection with its conversations, newest activity first. A
 * conversation whose group row is missing (written before its connection's
 * row) still shows, under a connection named by its address.
 *
 * @returns The tree.
 */
export async function loadTree(): Promise<ConnectionNode[]> {
	configureHistory();
	const [groups, sessions] = await Promise.all([AgentSession.getGroups(), AgentSession.getSessions(0, TREE_LIMIT)]);

	// step: one node per group, then any group a conversation names but the catalog lacks
	const nodes = new Map<string, ConnectionNode>();
	for (const group of groups) nodes.set(group.id, { group, conversations: [], activity: group.date });
	for (const meta of sessions) {
		if (!meta.group) continue;
		let node = nodes.get(meta.group);
		if (!node) {
			node = { group: { id: meta.group, title: meta.group, date: meta.date }, conversations: [], activity: meta.date };
			nodes.set(meta.group, node);
		}
		node.conversations.push(meta);
		node.activity = Math.max(node.activity, meta.date);
	}

	// step: newest first, at both levels
	const out = [...nodes.values()];
	for (const node of out) node.conversations.sort((a, b) => b.date - a.date);
	return out.sort((a, b) => b.activity - a.activity);
}

// =============================================================================
// WRITES (the catalog's one writer: the app, or the dev tool's sidebar)
// =============================================================================

/**
 * Adds or refreshes a connection (opening an agent).
 *
 * @param group - The group row.
 */
export async function saveConnection(group: AgentSessionGroup): Promise<void> {
	configureHistory();
	await AgentSession.saveGroup(group);
}

/**
 * Removes a connection with all its conversations.
 *
 * @param id - The connection's id (the agent's address).
 */
export async function removeConnection(id: string): Promise<void> {
	configureHistory();
	await AgentSession.deleteGroup(id);
}

/**
 * Deletes one conversation (its file and its row).
 *
 * @param sessionId - The conversation's id.
 */
export async function deleteConversation(sessionId: string): Promise<void> {
	configureHistory();
	await AgentSession.deleteSession(sessionId);
}

/**
 * Commits a conversation's row after its file was written.
 *
 * @param meta - The row.
 */
export async function commitConversation(meta: AgentSessionMeta): Promise<void> {
	configureHistory();
	await AgentSession.saveSessionMeta(meta);
}

// =============================================================================
// ONE CONVERSATION (written by whoever shows it)
// =============================================================================

/**
 * Opens one conversation, or a new one in a connection.
 *
 * @param connectionId - The connection's id.
 * @param sessionId - The conversation's id, or null for a new one.
 * @returns The session.
 */
export async function openConversation(connectionId: string, sessionId: string | null): Promise<AgentSession> {
	configureHistory();
	return sessionId ? AgentSession.getSession(sessionId) : AgentSession.newSession(connectionId);
}

export { AgentSession };
