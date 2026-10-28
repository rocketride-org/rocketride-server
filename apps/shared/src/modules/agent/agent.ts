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

import { getClient } from 'shell';
import type { ChatMessage, TextResult } from 'shell';
import type { ChatTurn } from 'shell/src/components/chat/types';
import { getAgentHost } from './host';
import { BUILDER_PROMPTS } from './prompts';
import { runAgent } from './run';
import { configureSessions, deleteSession as deleteStoredSession, getAgentSessions, getContext, isNotFound, saveSession } from './sessions';
import type { AgentSessionFile, AgentSessionMeta } from './sessions';
// TEMPORARY (spec §11): delete when Rod's wiring lands
import { StandinPipelines } from './standin';
import { looksLikeCredential, redactText } from './toolkits/common';
import type { AppPrompts } from './wave/plan';

export type { AgentSessionFile, AgentSessionMeta } from './sessions';
export { AGENTS_DIR } from './sessions';

// =============================================================================
// TRANSPORT
// =============================================================================

/** Streaming callback: one (type, content) pair per agent output chunk. */
export type AgentCallback = (type: string, content: string) => void;

/** What one agent request is run with. Every part but the turn has a default. */
export interface AgentOptions {
	/** The chat turn the request runs in: the conversation before it, the signal Stop aborts, and the messages the user sends during it. */
	turn: ChatTurn;
	/** The mounting app's workspace map and guide router (default: the pipe builder's). */
	prompts?: AppPrompts;
	/** The token of a running LLM pipeline (default: the stand-in pipeline, TEMPORARY). */
	token?: string;
	/** The conversation the request belongs to; names its stand-in pipeline (TEMPORARY). */
	conversationId?: string;
}

// TEMPORARY (spec §11): delete when Rod's wiring lands
/** The stand-in model pipelines, one per conversation. */
const standin = new StandinPipelines(getClient);

/**
 * The agent transport: one request, run to its answer. Progress and the
 * answer stream to the callback.
 *
 * @param request - The user's request text.
 * @param callback - Receives each output chunk as (type, content).
 * @param options - The chat turn, the app's prompts, and the model pipeline.
 */
export async function agent(request: string, callback: AgentCallback, options: AgentOptions): Promise<void> {
	const { turn, prompts = BUILDER_PROMPTS, token: given, conversationId = crypto.randomUUID() } = options;
	// TEMPORARY (spec §11): delete when Rod's wiring lands
	// step: a given token is used as is; without one, the conversation's stand-in pipeline answers (and restarts on a failure)
	const token = given ? async () => given : () => standin.token(conversationId);
	const onPipelineError = given
		? undefined
		: async () => {
				await standin.restart(conversationId);
			};
	await runAgent(request, callback, { history: [...turn.history], prompts, token, onPipelineError, signal: turn.signal, takeQueued: () => turn.takeQueued(), ask: (card) => turn.ask(card) }, { host: getAgentHost(), client: getClient });
}

// =============================================================================
// CHUNKS — where a run's streamed chunks go
// =============================================================================

/**
 * A run streams `thinking` chunks (one per wave) and `content` chunks (the
 * answer). The chat shows thinking live when it hands the session a status
 * sink; without one, every chunk is collected and returned when the run ends.
 */

/**
 * Makes the callback a run streams its chunks to, and the list the chunks
 * that are not sent live collect in.
 *
 * @param onStatus - The chat's live status sink. With it, each `thinking` chunk goes there as it arrives and is not collected; without it, every chunk is collected.
 * @returns The callback to run with, and the collected rows (`content` has an empty key, any other type keeps its own).
 */
function routeChunks(onStatus?: AgentCallback): { callback: AgentCallback; results: TextResult[] } {
	const results: TextResult[] = [];
	const callback: AgentCallback = (type, content) => {
		// step: a thinking chunk goes straight to the live sink when there is one
		if (onStatus && type === 'thinking') onStatus(type, content);
		else results.push({ text: content, key: type === 'content' ? '' : type });
	};
	return { callback, results };
}

// =============================================================================
// AGENT SESSION
// =============================================================================

/** Display-title cap — the first request truncated for the catalog row. */
const TITLE_MAX = 60;

/** The default title a session carries until its first request names it. */
const UNTITLED = 'New session';

/**
 * The error row for a message that looks like it holds a key. The model is
 * not called, so the key goes nowhere; the user row, live and saved, has it
 * redacted.
 *
 * @param kind - What the key looks like, as looksLikeCredential names it.
 * @returns The message the chat shows as an error.
 */
function pastedKeyMessage(kind: string): string {
	return `That message looks like it contains a key (${kind}). I did not send it to the model. Put it in Variables and refer to it as \${ROCKETRIDE_<NAME>}.`;
}

/**
 * The note for a key sent while a turn runs. The chat shows it as markdown,
 * so the placeholder sits in a code span.
 *
 * @param kind - What the key looks like, as looksLikeCredential names it.
 * @returns The note.
 */
function removedKeyNote(kind: string): string {
	return `I removed a key (${kind}) from your message, so it was not sent. Put it in Variables and refer to it as \`\${ROCKETRIDE_<NAME>}\`.`;
}

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
	/** What screen() sent in place of a message with a key, each with what the key looked like. */
	private readonly withheld = new Map<string, string>();

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
	 * Readies what the user typed before the chat makes it a row. A message
	 * that looks like it holds a key comes back with each key as `[redacted]`,
	 * so no row shows the key, live or queued. A turn that opens on it is
	 * refused like the message itself (execute); a running turn that takes it
	 * reads it without the key.
	 *
	 * @param text - What the user typed.
	 * @returns The text to send, and the note to show when it is sent during a turn ('' when it held no key).
	 */
	screen(text: string): { text: string; note: string } {
		const kind = looksLikeCredential(text);
		if (!kind) return { text, note: '' };
		const sent = redactText(text);
		this.withheld.set(sent, kind);
		return { text: sent, note: removedKeyNote(kind) };
	}

	/**
	 * Runs one request through the agent transport. This is the `request`
	 * function injected into useChatMessages: the hook renders each returned
	 * TextResult as a bot message (and owns the user-message append).
	 *
	 * @param text - The user's request.
	 * @param onStatus - The chat's live status sink (the hook's second `request` argument). With it, each `thinking` chunk goes to it as it arrives and is not returned; without it, every chunk is returned.
	 * @param turn - The running chat turn (the hook's third `request` argument). The hook always passes it; it is optional only because the shell's v0 `request` type is frozen.
	 * @returns One TextResult per agent output chunk that was not sent to the sink.
	 * @throws When no turn is passed, or when the request looks like it holds a key; the hook shows the message as an error row, and the model is never called.
	 */
	async execute(text: string, onStatus?: AgentCallback, turn?: ChatTurn): Promise<TextResult[]> {
		// queued turns can chain with no idle save between them, so this.messages may miss the turn before; the turn's history never does
		if (!turn) throw new Error('AgentSession.execute runs inside a chat turn: pass the turn useChatMessages hands its request.');
		// step: the first request names the session for the catalog row; a key is
		// redacted before the cut, so no part of one lands in the title
		if (this.title === UNTITLED) {
			const title = redactText(text);
			this.title = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
		}
		// step: a request that looks like it holds a key, or that screen() sent without one, never reaches the model
		const kind = looksLikeCredential(text) ?? this.withheld.get(text);
		if (kind) throw new Error(pastedKeyMessage(kind));
		// step: thinking streams live to the sink; the rest is collected into renderable rows
		const { callback, results } = routeChunks(onStatus);
		// TEMPORARY (spec §11): delete when Rod's wiring lands
		await agent(text, callback, { turn, conversationId: this.sessionId });
		return results;
	}

	/**
	 * Persists the conversation (session file + catalog row). Called by the
	 * provider after each completed exchange with the hook's message list.
	 * Every row and the title pass through redactText, so a key the user
	 * pasted is stored, and shown again when the session reopens, only as
	 * `[redacted]`. The history a turn sends is redacted in run.ts (toHistory).
	 *
	 * @param messages - The full conversation as rendered by the chat hook.
	 */
	async save(messages: ChatMessage[]): Promise<void> {
		const rows = messages.map((m) => ({ ...m, text: redactText(m.text) }));
		this.messages = rows;
		await saveSession({
			version: 1,
			sessionId: this.sessionId,
			title: redactText(this.title),
			date: this.date,
			contextRefs: this.contextRefs,
			messages: rows,
		});
	}
}
