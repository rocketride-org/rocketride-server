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
// AGENT — the workspace coding agent: transport stub + AgentSession API
// =============================================================================

/**
 * The host-facing surface of the workspace agent. An agent session is a
 * persisted conversation that can operate on ANY of the user's apps, nodes,
 * and pipelines — the LLM decides per tool invocation what to touch. Only
 * the session HISTORY is namespaced, by the controlling (hosting) app id,
 * so multiple host apps can mount the Agent tab without mixing histories.
 *
 * Hosts touch exactly one thing here: the AgentSession class. Configure it
 * once with the controlling app id, list sessions for the sidebar, open one
 * per conversation tab, and drive it through execute()/save().
 */

import type { ChatMessage, TextResult } from 'shell';
import { configureSessions, deleteSession as deleteStoredSession, getAgentSessions, getContext, isNotFound, saveSession } from './sessions';
import type { AgentSessionFile, AgentSessionMeta } from './sessions';

export type { AgentSessionFile, AgentSessionMeta } from './sessions';
export { AGENTS_DIR } from './sessions';

// =============================================================================
// TRANSPORT
// =============================================================================

/** Streaming callback: one (type, content) pair per agent output chunk. */
export type AgentCallback = (type: string, content: string) => void;

/**
 * The low-level agent transport — the seam the real backend call replaces.
 * The stub answers every request with a single content chunk.
 *
 * @param _request - The user's request text (unused by the stub).
 * @param callback - Receives each output chunk as (type, content).
 */
export async function agent(_request: string, callback: AgentCallback): Promise<void> {
	callback('content', 'TO DO');
}

// =============================================================================
// AGENT SESSION
// =============================================================================

/** Display-title cap — the first request truncated for the catalog row. */
const TITLE_MAX = 60;

/** The default title a session carries until its first request names it. */
const UNTITLED = 'New session';

/**
 * One agent conversation. The mounted tab provider owns its instance:
 * Documents keeps open tabs mounted, so switching tabs never unmounts a
 * conversation, and reopening a closed tab reloads from disk via
 * getSession(). (No instance registry — revisit when real agent runs can
 * outlive their tab.)
 */
export class AgentSession {
	/** The session's GUID. */
	readonly sessionId: string;
	/** Display title — the first user request, truncated. */
	title: string;
	/** Epoch-ms creation stamp. */
	readonly date: number;
	/** Workspace-relative paths the conversation references (future context chips). */
	contextRefs: string[];
	/** The persisted conversation, hydrated for useChatMessages initialMessages. */
	messages: ChatMessage[];

	/**
	 * Builds an in-memory session; private — hosts go through the statics.
	 *
	 * @param sessionId - The session GUID.
	 * @param title - Display title.
	 * @param date - Epoch-ms creation stamp.
	 * @param contextRefs - Workspace-relative context paths.
	 * @param messages - The stored conversation.
	 */
	private constructor(sessionId: string, title: string, date: number, contextRefs: string[], messages: ChatMessage[]) {
		this.sessionId = sessionId;
		this.title = title;
		this.date = date;
		this.contextRefs = contextRefs;
		this.messages = messages;
	}

	// ── Statics — session management ─────────────────────────────────────

	/**
	 * Stamps the controlling app id that namespaces session HISTORY (never
	 * an operational restriction). Hosts call this once at startup; every
	 * storage access throws until it has run.
	 *
	 * @param appId - The hosting app's id (e.g. 'rocketride.pipeBuilder').
	 */
	static configure(appId: string): void {
		configureSessions(appId);
	}

	/**
	 * Lists the available sessions, newest first.
	 *
	 * @param offset - Rows to skip. Defaults to 0.
	 * @param count - Maximum rows to return. Defaults to 100.
	 * @returns The catalog page for the sidebar session list.
	 */
	static getSessions(offset = 0, count = 100): Promise<AgentSessionMeta[]> {
		return getAgentSessions(offset, count);
	}

	/**
	 * Opens one session fully loaded. A missing file (a fresh id whose first
	 * message was never sent) yields an empty conversation. Every OTHER
	 * failure (transport drop, store timeout, corrupt JSON) propagates: an
	 * empty session under the same id would get saved over the stored
	 * history on the next send.
	 *
	 * @param sessionId - The session GUID.
	 * @returns The hydrated session.
	 */
	static async getSession(sessionId: string): Promise<AgentSession> {
		let raw: string;
		try {
			raw = await getContext(sessionId);
		} catch (err) {
			// step: nothing stored yet — a brand-new session
			if (isNotFound(err)) return new AgentSession(sessionId, UNTITLED, Date.now(), [], []);
			throw err;
		}
		const stored = JSON.parse(raw) as AgentSessionFile;
		return new AgentSession(sessionId, stored.title ?? UNTITLED, stored.date ?? Date.now(), stored.contextRefs ?? [], stored.messages ?? []);
	}

	/**
	 * Mints a brand-new session. Nothing is written to disk until the first
	 * send — abandoned empty sessions leave no files.
	 *
	 * @returns The new in-memory session.
	 */
	static newSession(): AgentSession {
		return new AgentSession(crypto.randomUUID(), UNTITLED, Date.now(), [], []);
	}

	/**
	 * Deletes one session: its file and its catalog row. The storage layer
	 * announces both on the shell event bus.
	 *
	 * @param sessionId - The session GUID.
	 */
	static deleteSession(sessionId: string): Promise<void> {
		return deleteStoredSession(sessionId);
	}

	// ── Instance — one conversation ──────────────────────────────────────

	/**
	 * Runs one request through the agent transport. This is the `request`
	 * function injected into useChatMessages: the hook renders each returned
	 * TextResult as a bot message (and owns the user-message append).
	 *
	 * @param text - The user's request.
	 * @returns One TextResult per agent output chunk.
	 */
	async execute(text: string): Promise<TextResult[]> {
		// step: the first request names the session for the catalog row
		if (this.title === UNTITLED) {
			this.title = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
		}
		// step: collect the transport's streamed chunks into renderable rows
		const results: TextResult[] = [];
		await agent(text, (type, content) => {
			results.push({ text: content, key: type === 'content' ? '' : type });
		});
		return results;
	}

	/**
	 * Persists the conversation (session file + catalog row). Called by the
	 * provider after each completed exchange with the hook's message list.
	 *
	 * @param messages - The full conversation as rendered by the chat hook.
	 */
	async save(messages: ChatMessage[]): Promise<void> {
		this.messages = messages;
		await saveSession({
			version: 1,
			sessionId: this.sessionId,
			title: this.title,
			date: this.date,
			contextRefs: this.contextRefs,
			messages,
		});
	}
}
