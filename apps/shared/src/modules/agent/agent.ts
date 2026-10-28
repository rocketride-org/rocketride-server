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
import { choiceAction, CONTINUE, CONTINUE_TEXT, failedTurn, OPEN_VARIABLES, redactDeep, TurnError, turnCard, type RunRecord, type TurnCardAction, type TurnRecord, type TurnResult } from './turn';
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
	/** The conversation the request belongs to; names its stand-in pipeline (TEMPORARY), and owns the runs the request starts. */
	conversationId?: string;
	/** The turn's id (default: a new one). */
	turnId?: string;
	/** The runs the conversation started; the request adds the ones it starts. */
	runs?: RunRecord[];
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
 * @returns How the turn ended.
 * @throws A TurnError when the model fails before the run gathered anything.
 */
export async function agent(request: string, callback: AgentCallback, options: AgentOptions): Promise<TurnResult> {
	const { turn, prompts = BUILDER_PROMPTS, token: given, conversationId = crypto.randomUUID(), turnId, runs } = options;
	// TEMPORARY (spec §11): delete when Rod's wiring lands
	// step: a given token is used as is; without one, the conversation's stand-in pipeline answers (and restarts on a failure)
	const token = given ? async () => given : () => standin.token(conversationId);
	const onPipelineError = given
		? undefined
		: async () => {
				await standin.restart(conversationId);
			};
	return runAgent(request, callback, { history: [...turn.history], prompts, token, onPipelineError, signal: turn.signal, takeQueued: () => turn.takeQueued(), ask: (card) => turn.ask(card), turnId, conversationId, runs }, { host: getAgentHost(), client: getClient });
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
 * Names a workspace scope for the user.
 *
 * @param scopeKey - The scope key ('' for the user's own files, 'team-<id>' for a team's).
 * @param name - The team's name, when the host has it; otherwise the team is named by its id.
 * @returns The scope as a phrase.
 */
function scopeName(scopeKey: string, name?: string): string {
	if (scopeKey === '') return 'your personal workspace';
	if (!scopeKey.startsWith('team-')) return scopeKey;
	return `team ${name || scopeKey.slice('team-'.length)}`;
}

/**
 * What the model reads under a reply that answers a needs-you request, so a
 * late or second answer can be told apart.
 *
 * @param id - The request's id.
 * @returns The note.
 */
function answeringNote(id: string): string {
	return `(answering request ${id})`;
}

/** The start of the row that closes a turn the Agent tab closed on; the model reads it as a stop by the user. */
const CLOSED_TAB = 'Stopped by you: the Agent tab closed.';

/** What a card press may do outside the session: open a file, open Variables, or send a message. */
export interface CardActionHandlers {
	/** Opens a workspace file in its editor. */
	openFile(path: string): void;
	/** Opens the Variables overlay. */
	openVariables(): void;
	/** Sends a message as the user, as the composer does. */
	send(text: string): void;
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
	/** The workspace scope the conversation runs in; set by its first request, unset in sessions saved before scopes. */
	scopeKey?: string;
	/** Every turn that ended, linked to the row that closes it, oldest first. A version 1 file has none. */
	readonly turns: TurnRecord[];
	/** The pipeline runs this conversation started, which Auto may stop or restart. A version 1 file has none. */
	readonly runsStarted: RunRecord[];
	/** Whether the conversation has a session file (loaded from one, or saved since). */
	private stored = false;
	/** What screen() sent in place of a message with a key, each with what the key looked like. */
	private readonly withheld = new Map<string, string>();
	/** Turns that ended and have no row linked yet, each with the index of its opening user row. */
	private readonly pending: Array<{ turn: TurnResult; opening: number }> = [];
	/** How many turns are running. */
	private running = 0;
	/** Set once the Agent tab unmounted: from then on a turn that ends saves itself. */
	private detached = false;
	/** The request a card button answered, while its reply is on the way. */
	private claimed: string | null = null;
	/** The last save, so saves land in order. */
	private saving: Promise<void> = Promise.resolve();

	/**
	 * Builds an in-memory session; private — hosts go through the statics.
	 *
	 * @param sessionId - The session GUID.
	 * @param title - Display title.
	 * @param date - Epoch-ms creation stamp.
	 * @param contextRefs - Workspace-relative context paths.
	 * @param messages - The stored conversation.
	 * @param scopeKey - The workspace scope it runs in, when known.
	 * @param turns - The turns, linked to their rows.
	 * @param runsStarted - The runs the conversation started.
	 */
	private constructor(sessionId: string, title: string, date: number, contextRefs: string[], messages: ChatMessage[], scopeKey?: string, turns: TurnRecord[] = [], runsStarted: RunRecord[] = []) {
		this.sessionId = sessionId;
		this.title = title;
		this.date = date;
		this.contextRefs = contextRefs;
		this.messages = messages;
		this.scopeKey = scopeKey;
		this.turns = turns;
		this.runsStarted = runsStarted;
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
		// step: a version 1 file has no turns and no runs, so its runs are nobody's
		const v2 = stored.version === 2;
		const session = new AgentSession(sessionId, stored.title ?? UNTITLED, stored.date ?? Date.now(), stored.contextRefs ?? [], stored.messages ?? [], stored.scopeKey, v2 ? (stored.turns ?? []) : [], v2 ? (stored.runsStarted ?? []) : []);
		session.stored = true;
		return session;
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
	 * @returns One TextResult per agent output chunk that was not sent to the sink, and how the turn ended.
	 * @throws When no turn is passed, when the conversation belongs to another scope than the host's, when the request looks like it holds a key, or when the model fails before the run gathered anything; the hook shows the message as an error row. Every turn that started still ends in `turns`.
	 */
	async execute(text: string, onStatus?: AgentCallback, turn?: ChatTurn): Promise<{ results: TextResult[]; turn: TurnResult }> {
		// queued turns can chain with no idle save between them, so this.messages may miss the turn before; the turn's history never does
		if (!turn) throw new Error('AgentSession.execute runs inside a chat turn: pass the turn useChatMessages hands its request.');
		// step: one terminal path: whatever happens below, the turn ends here once, refused, failed, stopped or answered
		const turnId = crypto.randomUUID();
		const opening = turn.history.length;
		let result: TurnResult | undefined;
		let started = false;
		this.running++;
		try {
			const { results, turn: ended } = await this.run(text, onStatus, turn, turnId, () => {
				started = true;
			});
			result = ended;
			return { results, turn: ended };
		} catch (err) {
			result = err instanceof TurnError ? err.turn : failedTurn(turnId, err, !started, this.scopeKey);
			throw err;
		} finally {
			this.running--;
			if (result) this.ended(result, opening);
		}
	}

	/**
	 * The body of execute: the scope rule, the title, the key check, then the run.
	 *
	 * @param text - The user's request.
	 * @param onStatus - The chat's live status sink.
	 * @param turn - The running chat turn.
	 * @param turnId - The turn's id.
	 * @param starting - Called once the message passed every check, just before the run.
	 * @returns The collected rows and the turn's result.
	 */
	private async run(text: string, onStatus: AgentCallback | undefined, turn: ChatTurn, turnId: string, starting: () => void): Promise<{ results: TextResult[]; turn: TurnResult }> {
		// step: a conversation runs in the scope it started in; the chat shows the refusal as an error
		const host = getAgentHost();
		const scopeKey = host.scopeKey;
		const stamped = scopeKey !== undefined && this.scopeKey === undefined;
		if (scopeKey !== undefined) {
			if (this.scopeKey !== undefined && this.scopeKey !== scopeKey) {
				throw new Error(`This conversation belongs to ${scopeName(this.scopeKey, host.scopeName?.(this.scopeKey))}; switch back to continue it.`);
			}
			this.scopeKey = scopeKey;
		}
		// step: the first request names the session for the catalog row; a key is
		// redacted before the cut, so no part of one lands in the title
		if (this.title === UNTITLED) {
			const title = redactText(text);
			this.title = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
		}
		// step: a stored conversation saved before scopes records its scope before the model is called. A turn
		// that ends by unmount (a team switch) misses the idle save, and the catalog is shared by every team.
		if (stamped && this.stored) {
			await this.save(this.messages).catch((err) => {
				console.log("[AgentSession] could not record the conversation's scope", err);
			});
		}
		// step: a request that looks like it holds a key, or that screen() sent without one, never reaches the model
		const kind = looksLikeCredential(text) ?? this.withheld.get(text);
		if (kind) throw new Error(pastedKeyMessage(kind));
		// step: this message is the user's reply to an open needs-you request, so it answers it, and the model reads which
		const answering = this.takeRequest(turnId);
		starting();
		// step: thinking streams live to the sink; the rest is collected into renderable rows
		const { callback, results } = routeChunks(onStatus);
		// TEMPORARY (spec §11): delete when Rod's wiring lands
		const ended = await agent(answering ? `${text}\n\n${answeringNote(answering)}` : text, callback, { turn, conversationId: this.sessionId, turnId, runs: this.runsStarted });
		return { results, turn: ended };
	}

	/**
	 * Marks every open needs-you request answered by this turn. Only the next
	 * user message after a needs-you turn answers it; later presses on its
	 * card do nothing.
	 *
	 * @param turnId - The turn whose message answers.
	 * @returns The id of the request it answers, or null when none was open.
	 */
	private takeRequest(turnId: string): string | null {
		this.claimed = null;
		let answered: string | null = null;
		for (const turn of [...this.turns, ...this.pending.map((p) => p.turn)]) {
			if (!turn.request || turn.request.answeredBy !== undefined) continue;
			turn.request = { ...turn.request, answeredBy: turnId };
			answered = turn.request.id;
		}
		return answered;
	}

	/**
	 * A turn ended. It waits for its closing row, which the chat writes after
	 * the request settles. When the chat already wrote it (Stop's grace ran out
	 * first), or the Agent tab is gone, nothing else saves the conversation, so
	 * the turn saves it here.
	 *
	 * @param turn - How the turn ended.
	 * @param opening - The index of the turn's opening user row.
	 */
	private ended(turn: TurnResult, opening: number): void {
		const result: TurnResult = this.detached && turn.outcome === 'stopped' ? { ...turn, reason: 'unmounted' } : turn;
		this.pending.push({ turn: result, opening });
		if (this.detached) this.closeDetached();
		if (this.detached || this.link(this.messages)) {
			this.persist(this.messages).catch((err) => {
				console.log('[AgentSession] could not save the ended turn', err);
			});
		}
	}

	/**
	 * Links each ended turn to the row that closes it: the first bot row after
	 * its opening user row that is not a thinking row (its answer, its error, or
	 * the stop row).
	 *
	 * @param messages - The chat's rows.
	 * @returns Whether any turn was linked.
	 */
	private link(messages: ChatMessage[]): boolean {
		let linked = false;
		for (const entry of [...this.pending]) {
			if (messages[entry.opening]?.sender !== 'user') continue;
			const closing = messages.slice(entry.opening + 1).find((m) => m.sender === 'bot' && !m.resultKey && !m.queued);
			if (!closing) continue;
			this.pending.splice(this.pending.indexOf(entry), 1);
			this.turns.push({ ...entry.turn, messageId: closing.id });
			linked = true;
		}
		return linked;
	}

	/**
	 * Writes the closing row the chat can no longer write, for each ended turn
	 * of a tab that unmounted: the turn's answer, or for a stopped turn a stop
	 * row with the progress the chat showed, as the chat's own stop row has.
	 */
	private closeDetached(): void {
		for (const { turn, opening } of this.pending) {
			const rows = this.messages;
			if (rows[opening]?.sender !== 'user' || rows.slice(opening + 1).some((m) => m.sender === 'bot' && !m.resultKey && !m.queued)) continue;
			const progress = rows.slice(opening).filter((m) => m.sender === 'status' && !m.queued);
			const text = turn.finalText || [CLOSED_TAB, ...(progress.length ? ['Progress before the stop:', ...progress.map((m) => m.text)] : [])].join('\n\n');
			const row: ChatMessage = { id: rows.reduce((max, m) => Math.max(max, m.id), 0) + 1, text, sender: 'bot', timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
			const at = rows.findIndex((m) => m.queued);
			this.messages = at < 0 ? [...rows, row] : [...rows.slice(0, at), row, ...rows.slice(at)];
		}
		this.link(this.messages);
	}

	/**
	 * The Agent tab mounted. A tab mounted again after detach (React's dev
	 * double mount runs the unmount once at start) shows the turns again, so
	 * a turn that ends waits for the chat's rows.
	 */
	attach(): void {
		this.detached = false;
	}

	/**
	 * The Agent tab is unmounting (closed, or a team switch). The chat's rows
	 * go with it, so the session keeps the last rows it showed and saves them
	 * now, in the conversation's own scope. A turn still running stops with the
	 * tab; when it ends, it adds its closing row and saves again.
	 *
	 * @param messages - The rows the chat showed last.
	 */
	detach(messages: ChatMessage[]): void {
		if (this.detached) return;
		this.detached = true;
		const last = this.messages.at(-1);
		const unchanged = messages.length === this.messages.length && messages.at(-1)?.id === last?.id;
		if (this.running === 0 && this.pending.length === 0 && unchanged) return;
		this.messages = messages;
		this.closeDetached();
		this.persist(this.messages).catch((err) => {
			console.log('[AgentSession] could not save the conversation on unmount', err);
		});
	}

	/**
	 * The rows with each linked turn's card under its row. Error rows show
	 * their own banner, so they get none. Turns that ended since the last call
	 * are linked first.
	 *
	 * @param messages - The chat's rows.
	 * @returns The rows to show and save; the same array when no row has a turn.
	 */
	decorate(messages: ChatMessage[]): ChatMessage[] {
		this.link(messages);
		if (this.turns.length === 0) return messages;
		const byRow = new Map(this.turns.map((t) => [t.messageId, t]));
		return messages.map((m) => {
			const turn = byRow.get(m.id);
			if (!turn || m.isError) return m;
			// a request a card button already answered shows its buttons disabled while the reply is on its way
			const shown = turn.request && turn.request.id === this.claimed ? { ...turn, request: { ...turn.request, answeredBy: '' } } : turn;
			return { ...m, card: turnCard(shown) };
		});
	}

	/**
	 * Handles a press on a turn's card. A file link opens the file, Open
	 * Variables opens the Variables overlay, and a choice or Continue sends its
	 * text as the user's reply. A reply goes only to the open request, once: a
	 * press on a card whose request was answered, or a second press, does
	 * nothing.
	 *
	 * @param messageId - The row the card is under.
	 * @param action - What was pressed.
	 * @param handlers - Opens files and Variables, and sends.
	 * @returns Whether the press did anything.
	 */
	cardAction(messageId: number, action: TurnCardAction, handlers: CardActionHandlers): boolean {
		if (action.kind === 'file') {
			handlers.openFile(action.path);
			return true;
		}
		if (action.id === OPEN_VARIABLES) {
			handlers.openVariables();
			return true;
		}
		const request = this.turns.find((t) => t.messageId === messageId)?.request;
		if (!request || request.answeredBy !== undefined || this.claimed === request.id) return false;
		const reply = request.kind === 'continue' ? (action.id === CONTINUE ? CONTINUE_TEXT : undefined) : request.choices?.find((_, i) => choiceAction(i) === action.id);
		if (reply === undefined) return false;
		this.claimed = request.id;
		handlers.send(reply);
		return true;
	}

	/**
	 * Persists the conversation (session file + catalog row). Called by the
	 * provider after each completed exchange with the hook's message list.
	 * Every row, card, turn and run record and the title pass through
	 * redactText, so a key the user pasted is stored, and shown again when the
	 * session reopens, only as `[redacted]`. The history a turn sends is
	 * redacted in run.ts (toHistory).
	 *
	 * @param messages - The full conversation as rendered by the chat hook.
	 */
	async save(messages: ChatMessage[]): Promise<void> {
		await this.persist(messages);
	}

	/**
	 * Writes the session file, version 2: the rows with their cards, the turns
	 * and the runs. Writes land in the order they were asked for.
	 *
	 * @param messages - The rows to keep.
	 */
	private async persist(messages: ChatMessage[]): Promise<void> {
		const rows = this.decorate(messages).map((m) => ({ ...m, text: redactText(m.text), ...(m.card ? { card: redactDeep(m.card) } : {}) }));
		this.messages = rows;
		const file: AgentSessionFile = {
			version: 2,
			sessionId: this.sessionId,
			title: redactText(this.title),
			date: this.date,
			contextRefs: this.contextRefs,
			messages: rows,
			...(this.scopeKey !== undefined ? { scopeKey: this.scopeKey } : {}),
			turns: redactDeep(this.turns),
			runsStarted: redactDeep(this.runsStarted),
		};
		const write = this.saving.then(() => saveSession(file));
		this.saving = write.catch(() => undefined);
		await write;
		this.stored = true;
	}
}
