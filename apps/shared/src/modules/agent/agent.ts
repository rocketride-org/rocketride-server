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
 * per conversation (every tab of it gets the same instance), and drive its
 * chat through request.
 */

import { getClient } from 'shell';
import type { ChatMessage, TextResult } from 'shell';
import type { TurnController } from 'shell/src/components/chat/turns/turnController';
import type { ChatCard, ChatCardAction, ChatTurn } from 'shell/src/components/chat/types';
import { findAgentHost, getAgentHost } from './host';
import { DEFAULT_MODEL, parseModelChoice, type ModelChoice } from './model';
import { openChatModel } from './modelEngine';
import { BUILDER_PROMPTS } from './prompts';
import { runAgent } from './run';
import { configureSessions, deleteSession as deleteStoredSession, getAgentSessions, getContext, isNotFound, saveSession } from './sessions';
import type { AgentSessionFile, AgentSessionMeta } from './sessions';
import { looksLikeCredential, redactDeep, redactText } from './toolkits/common';
import type { UndoOutcome, UndoRecord } from './toolkits/undo';
import { choiceAction, CONTINUE, CONTINUE_TEXT, failedTurn, OPEN_VARIABLES, TurnError, turnCard, turnEvent, turnReport, UNDO, undoParts, usageMeta, type RunRecord, type TurnRecord, type TurnReport, type TurnResult } from './turn';
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
	/** The model that answers (default: DEFAULT_MODEL). */
	model?: ModelChoice;
	/** The conversation the request belongs to; scopes its model's task, and owns the runs the request starts. */
	conversationId?: string;
	/** The turn's id (default: a new one). */
	turnId?: string;
	/** The runs the conversation started; the request adds the ones it starts. */
	runs?: RunRecord[];
	/** Takes the request's Undo record when its run ends. */
	undo?: (record: UndoRecord) => void;
	/** Where the turn's model requests and tool calls are reported, bound to the turn (default: nothing). */
	report?: TurnReport;
}

/**
 * The agent transport: one request, run to its answer. Progress and the
 * answer stream to the callback.
 *
 * @param callback - Receives each output chunk as (type, content).
 * @param options - The chat turn, the app's prompts, and the model.
 * @throws A TurnError when the model fails before the run gathered anything.
 */
export async function agent(request: string, callback: AgentCallback, options: AgentOptions): Promise<TurnResult> {
	const { turn, prompts = BUILDER_PROMPTS, model: choice = DEFAULT_MODEL, conversationId = crypto.randomUUID(), turnId, runs, undo, report } = options;
	const chatModel = openChatModel(choice, conversationId, getClient);
	return runAgent(request, callback, { history: [...turn.history], prompts, chatModel, signal: turn.signal, takeQueued: () => turn.takeQueued(), ask: (card) => turn.ask(card), turnId, conversationId, runs, undo, report }, { host: getAgentHost(), client: getClient });
}

// =============================================================================
// CHUNKS — where a run's streamed chunks go
// =============================================================================

/** Routes a run's chunks: `thinking` goes live to `onStatus` when given; the rest is collected in `results`. */
function routeChunks(onStatus?: AgentCallback): { callback: AgentCallback; results: TextResult[] } {
	const results: TextResult[] = [];
	const callback: AgentCallback = (type, content) => {
		if (onStatus && type === 'thinking') onStatus(type, content);
		else results.push({ text: content, key: type === 'content' ? '' : type });
	};
	return { callback, results };
}

// =============================================================================
// AGENT SESSION
// =============================================================================

function withUndo(card: ChatCard, state: 'ready' | 'waiting' | { unavailable: string }): ChatCard {
	const { lines = [], actions = [] } = undoParts(state);
	return { ...card, ...(lines.length ? { lines: [...(card.lines ?? []), ...lines] } : {}), ...(actions.length ? { actions: [...(card.actions ?? []), ...actions] } : {}) };
}

/** Display-title cap — the first request truncated for the catalog row. */
const TITLE_MAX = 60;

/** The default title a session carries until its first request names it. */
const UNTITLED = 'New session';

function pastedKeyMessage(kind: string): string {
	return `That message looks like it contains a key (${kind}). I did not send it to the model. Put it in Variables and refer to it as \${ROCKETRIDE_<NAME>}.`;
}

/** The note for a key sent while a turn runs; the chat renders markdown, so the placeholder sits in a code span. */
function removedKeyNote(kind: string): string {
	return `I removed a key (${kind}) from your message, so it was not sent. Put it in Variables and refer to it as \`\${ROCKETRIDE_<NAME>}\`.`;
}

function scopeName(scopeKey: string, name?: string): string {
	if (scopeKey === '') return 'your personal workspace';
	if (!scopeKey.startsWith('team-')) return scopeKey;
	return `team ${name || scopeKey.slice('team-'.length)}`;
}

/** What the model reads under a reply to a needs-you request, so a late or second answer can be told apart. */
function answeringNote(id: string): string {
	return `(answering request ${id})`;
}

/** The start of the row that closes a turn the Agent tab closed on; the model reads it as a stop by the user. */
const CLOSED_TAB = 'Stopped by you: the Agent tab closed.';

/** Each conversation's running Undo, by session id, until its note row is added. Every instance of the conversation sees it, so one reopened while Undo runs waits for it. */
const undoing = new Map<string, Promise<void>>();

/** Each closed conversation's last saves, by session id, until they land, so one reopened meanwhile reads them. */
const closing = new Map<string, Promise<void>>();

/**
 * Each open conversation's one session, by id. Every tab of the conversation, and a tab a layout change
 * draws again, gets this instance, so they all show one chat and one running turn. An entry leaves when
 * its chat closes for real (close()), or when its load fails so a later tab can try again.
 */
const open = new Map<string, { session: AgentSession | null; loading: Promise<AgentSession> }>();

/** What a card press may do outside the session: open a file, open Variables, send a message, or add a note. */
export interface CardActionHandlers {
	/** Opens a workspace file in its editor. */
	openFile(path: string): void;
	openVariables(): void;
	/** Sends a message as the user, as the composer does. */
	send(text: string): void;
	/** Adds a note row to the chat (what an Undo did). */
	note?(text: string): void;
}

/**
 * One agent conversation. An open conversation has one instance, from getSession(), shared by all its
 * tabs. The instance holds the chat, so a running turn outlives a tab drawn again and goes on in every
 * tab of it. Closing its last tab or switching teams stops the turn and drops the instance; reopening
 * reads the file again.
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
	private running = 0;
	/** Set once the conversation's chat closed for real: from then on a turn that ends writes its own closing row and saves. */
	private closed = false;
	/** The conversation's chat, from its first tab (adopt). */
	private controller: TurnController | null = null;
	/** How many rows the last idle save wrote, so a chat that only drew again is not saved. */
	private savedCount = 0;
	/** Stops the session hearing its chat. */
	private unlisten: (() => void) | null = null;
	/** Stops the host's onChatClosed watch. */
	private unwatch: (() => void) | null = null;
	/** The request a card button answered, while its reply is on the way. */
	private claimed: string | null = null;
	/** The conversation's model, which only setModel changes. */
	private chosen: ModelChoice;
	/** The last save, so saves land in order. */
	private saving: Promise<void> = Promise.resolve();
	/** The latest turn that ran, with its Undo record. In memory only: a reload starts with none. */
	private latest: { turnId: string; record: UndoRecord } | null = null;
	/** Called when what the cards show changes outside the chat's rows (Undo became ready, or ran). */
	private readonly listeners = new Set<() => void>();

	/**
	 * Builds an in-memory session; private — hosts go through the statics.
	 *
	 * @param sessionId - The session GUID.
	 * @param title - Display title.
	 * @param date - Epoch-ms creation stamp.
	 * @param contextRefs - Workspace-relative context paths.
	 * @param messages - The stored conversation.
	 * @param model - The stored model; anything unreadable, or none, takes the last pick, once, so another conversation's pick never moves this one.
	 */
	private constructor(sessionId: string, title: string, date: number, contextRefs: string[], messages: ChatMessage[], scopeKey?: string, turns: TurnRecord[] = [], runsStarted: RunRecord[] = [], model?: unknown) {
		this.sessionId = sessionId;
		this.title = title;
		this.date = date;
		this.contextRefs = contextRefs;
		this.messages = messages;
		this.scopeKey = scopeKey;
		this.turns = turns;
		this.runsStarted = runsStarted;
		this.chosen = parseModelChoice(model) ?? findAgentHost()?.lastModel?.read() ?? DEFAULT_MODEL;
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
	 * The open conversation's session, shared by every tab of it: the live instance when the
	 * conversation is open, else loaded once and kept until its chat closes (the host's onChatClosed).
	 * A missing file (a fresh id whose first message was never sent) yields an empty conversation.
	 * Every OTHER failure (transport drop, store timeout, corrupt JSON) propagates: an empty session
	 * under the same id would get saved over the stored history on the next send.
	 *
	 * @param sessionId - The session GUID.
	 * @returns The hydrated session.
	 */
	static getSession(sessionId: string): Promise<AgentSession> {
		const entry = open.get(sessionId);
		if (entry) return entry.loading;
		const made: { session: AgentSession | null; loading: Promise<AgentSession> } = { session: null, loading: AgentSession.load(sessionId) };
		open.set(sessionId, made);
		made.loading.then(
			(session) => {
				made.session = session;
				// step: the host says when the chat is really gone; it checks once at once, which catches a tab closed during the load
				session.unwatch = findAgentHost()?.onChatClosed?.(sessionId, () => session.close()) ?? null;
			},
			() => {
				if (open.get(sessionId) === made) open.delete(sessionId);
			}
		);
		return made.loading;
	}

	/**
	 * The open conversation's session when it is already loaded, else null: a tab drawn again by a
	 * layout change shows its chat in the same commit, with no "Loading session…" in between.
	 */
	static loaded(sessionId: string): AgentSession | null {
		return open.get(sessionId)?.session ?? null;
	}

	/** Reads a conversation from its file, once its running Undo has added its note and a closed instance's last saves have landed. */
	private static async load(sessionId: string): Promise<AgentSession> {
		await undoing.get(sessionId)?.catch(() => undefined);
		await closing.get(sessionId);
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
		const session = new AgentSession(sessionId, stored.title ?? UNTITLED, stored.date ?? Date.now(), stored.contextRefs ?? [], stored.messages ?? [], stored.scopeKey, v2 ? (stored.turns ?? []) : [], v2 ? (stored.runsStarted ?? []) : [], stored.model);
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

	/** The request every tab's chat runs (useChatMessages `request`): execute, bound to this session. */
	readonly request = (text: string, onStatus?: AgentCallback, turn?: ChatTurn): Promise<TextResult[]> => this.execute(text, onStatus, turn).then(({ results }) => results);

	/** The conversation's chat, once a tab made it; every tab passes it to useChatMessages as `controller`. */
	get chat(): TurnController | undefined {
		return this.controller ?? undefined;
	}

	/**
	 * Keeps the chat the conversation's first tab made, so every later tab, and a tab drawn again,
	 * runs on it. The first one wins; later calls, and calls after the close, do nothing. From then on
	 * the session saves the chat's rows each time it goes idle with new rows.
	 *
	 * @param chat - useChatMessages' returned `controller`.
	 */
	adopt(chat: TurnController): void {
		if (this.controller || this.closed) return;
		this.controller = chat;
		// a restored conversation that is idle is not saved on mount
		this.savedCount = chat.snapshot().messages.length;
		this.unlisten = chat.subscribe(() => this.saveIdle());
		// step: the first tab draws again and passes the chat back, so its unmount no longer stops it
		this.changed();
	}

	/** Persists after each completed exchange. */
	private saveIdle(): void {
		const { phase, messages } = this.controller!.snapshot();
		if (phase !== 'idle' || messages.length === this.savedCount) return;
		this.savedCount = messages.length;
		this.persist(messages).catch((err) => {
			console.log('[AgentSession] session save failed', err);
		});
	}

	/**
	 * The conversation's chat closed for real (the host's onChatClosed): its last tab closed, or a team
	 * switch. Stops a running turn, saves the rows the chat holds after the stop, and lets the
	 * conversation go, so reopening it reads the file once these saves land.
	 */
	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (open.get(this.sessionId)?.session === this) open.delete(this.sessionId);
		this.unwatch?.();
		this.unwatch = null;
		const saved = this.lastSave();
		closing.set(this.sessionId, saved);
		void saved.then(() => {
			if (closing.get(this.sessionId) === saved) closing.delete(this.sessionId);
		});
		const chat = this.controller;
		if (!chat) return;
		// step: from here the session writes its own rows (ended, closeDetached)
		this.unlisten?.();
		this.unlisten = null;
		// step: read after the stop, so no row is saved still queued; queued rows go back to a composer that is gone
		chat.stop();
		const rows = chat.snapshot().messages;
		const last = this.messages.at(-1);
		const unchanged = rows.length === this.messages.length && rows.at(-1)?.id === last?.id;
		if (this.running === 0 && this.pending.length === 0 && unchanged) return;
		this.messages = rows;
		this.closeDetached();
		this.persist(this.messages).catch((err) => {
			console.log('[AgentSession] could not save the conversation on close', err);
		});
	}

	/** Resolves once no turn of this conversation runs and every save asked so far has landed. */
	private lastSave(): Promise<void> {
		return new Promise<void>((resolve) => {
			const check = (): void => {
				if (this.running > 0) return;
				stop();
				resolve();
			};
			const stop = this.subscribe(check);
			check();
		}).then(() => this.saving);
	}

	/** The conversation's model. The same object until setModel, so the picker can read it directly. */
	get model(): ModelChoice {
		return this.chosen;
	}

	/**
	 * Sets the conversation's model, for its next turn: a running turn holds its own copy. It is also
	 * the last pick, which a new conversation starts from.
	 */
	setModel(choice: ModelChoice): void {
		this.chosen = choice;
		findAgentHost()?.lastModel?.write(choice);
		if (this.stored) {
			this.persist(this.messages).catch((err) => {
				console.log("[AgentSession] could not save the conversation's model", err);
			});
		}
		this.changed();
	}

	/**
	 * Readies what the user typed before the chat makes it a row: each key comes back as
	 * `[redacted]`, so no row shows it. A turn that opens on it is refused (see execute).
	 *
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
		// step: one terminal path: whatever happens below, the turn ends here once, refused, failed, stopped or answered, and reports its end
		const began = performance.now();
		const turnId = crypto.randomUUID();
		// the turn holds its model, so a pick during it changes neither what it asks nor what it reports
		const choice = this.chosen;
		const report = turnReport(findAgentHost()?.report, { turnId, conversationId: this.sessionId, model: choice.model });
		const opening = turn.history.length;
		let result: TurnResult | undefined;
		let started = false;
		let record: UndoRecord | null = null;
		this.running++;
		try {
			const { results, turn: ended } = await this.run(
				text,
				onStatus,
				turn,
				turnId,
				choice,
				report,
				() => {
					started = true;
					// step: only the latest turn can be undone, so one that starts ends the earlier turn's Undo; a refused message starts none
					this.latest = null;
				},
				(undo) => {
					record = undo;
				}
			);
			result = ended;
			return { results, turn: ended };
		} catch (err) {
			result = err instanceof TurnError ? err.turn : failedTurn(turnId, err, !started, this.scopeKey);
			throw err;
		} finally {
			this.running--;
			this.keepUndo(turnId, record);
			if (result) {
				const recorded = this.ended(result, opening);
				report('agent_turn:end', turnEvent(recorded, { ms: performance.now() - began, mode: findAgentHost()?.approvals?.run.read().mode ?? 'ask' }));
			}
			// step: a turn's card shows once it ends, which can come after the chat closed the turn (Stop's grace), so every tab redraws
			this.changed();
		}
	}

	/**
	 * Keeps the Undo record of the turn that just ended (null: it never ran). While one of its changes
	 * is still on its way, the card's Undo waits, and the card redraws when the last one ends.
	 */
	private keepUndo(turnId: string, record: UndoRecord | null): void {
		if (!record || !record.changed) return;
		const latest = { turnId, record };
		this.latest = latest;
		if (record.settled) return;
		const stop = record.onSettled(() => {
			stop();
			if (this.latest === latest) this.changed();
		});
	}

	/** The body of execute: scope rule, title, key check, then the run (`starting` fires just before it) on the turn's model, reporting to `report`. */
	private async run(text: string, onStatus: AgentCallback | undefined, turn: ChatTurn, turnId: string, choice: ModelChoice, report: TurnReport, starting: () => void, undo: (record: UndoRecord) => void): Promise<{ results: TextResult[]; turn: TurnResult }> {
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
		const { callback, results } = routeChunks(onStatus);
		const ended = await agent(answering ? `${text}\n\n${answeringNote(answering)}` : text, callback, { turn, model: choice, conversationId: this.sessionId, turnId, runs: this.runsStarted, undo, report });
		return { results, turn: ended };
	}

	/**
	 * Marks every open needs-you request answered by this turn: only the next user message answers it.
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
	 * A turn ended; it waits for its closing row. When the chat already wrote it (Stop's grace ran
	 * out first) or the chat closed, nothing else saves the conversation, so this does.
	 *
	 * @returns The turn as recorded: a stopped turn whose chat closed ends 'unmounted'.
	 */
	private ended(turn: TurnResult, opening: number): TurnResult {
		const result: TurnResult = this.closed && turn.outcome === 'stopped' ? { ...turn, reason: 'unmounted' } : turn;
		this.pending.push({ turn: result, opening });
		if (this.closed) this.closeDetached();
		if (this.closed || this.link(this.messages)) {
			this.persist(this.messages).catch((err) => {
				console.log('[AgentSession] could not save the ended turn', err);
			});
		}
		return result;
	}

	/**
	 * Links each ended turn to its closing row: the first non-thinking bot row after its opening
	 * user row. Returns whether any turn was linked.
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
	 * of a chat that closed: the turn's answer, or for a stopped turn a stop
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
	 * Hears when what the cards show changes outside the chat's rows: the
	 * latest turn's Undo became ready, or an Undo ran.
	 *
	 * @returns The unsubscribe.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private changed(): void {
		for (const listener of [...this.listeners]) listener();
	}

	/**
	 * The rows with each linked turn's card and estimated usage under its row (error rows show their
	 * own banner). The latest turn's card has Undo: a button, enabled only while the chat is idle and
	 * its changes have ended, or a line saying why it is unavailable.
	 *
	 * @returns The rows to show; the same array when no row has a turn.
	 */
	decorate(messages: ChatMessage[]): ChatMessage[] {
		return this.withCards(messages, true);
	}

	/** The rows with their cards, with or without Undo (a saved card has none: Undo does not outlive the page). */
	private withCards(messages: ChatMessage[], undo: boolean): ChatMessage[] {
		this.link(messages);
		if (this.turns.length === 0) return messages;
		const byRow = new Map(this.turns.map((t) => [t.messageId, t]));
		const latest = undo ? this.undoState() : null;
		return messages.map((m) => {
			const turn = byRow.get(m.id);
			if (!turn || m.isError) return m;
			// a request a card button already answered shows its buttons disabled while the reply is on its way
			const shown = turn.request && turn.request.id === this.claimed ? { ...turn, request: { ...turn.request, answeredBy: '' } } : turn;
			const card = latest && latest.turnId === turn.turnId ? withUndo(turnCard(shown), latest.state) : turnCard(shown);
			const meta = usageMeta(turn);
			return { ...m, card, ...(meta ? { meta } : {}) };
		});
	}

	/**
	 * What the latest turn's card says about Undo: nothing when the turn changed no file or the team
	 * switched; why it is unavailable; a waiting button while anything still runs; else the button.
	 */
	private undoState(): { turnId: string; state: 'ready' | 'waiting' | { unavailable: string } } | null {
		const latest = this.latest;
		if (!latest || findAgentHost()?.vfs !== latest.record.vfs) return null;
		const state = latest.record.state();
		if (state === 'none') return null;
		if (state === 'ready' && (this.running > 0 || undoing.has(this.sessionId))) return { turnId: latest.turnId, state: 'waiting' };
		return { turnId: latest.turnId, state };
	}

	/**
	 * Undoes the latest turn's file changes from its card; one level only. The note row says what
	 * happened and is what the model reads.
	 * @returns Whether the press started an Undo.
	 */
	private undoFrom(messageId: number, handlers: CardActionHandlers): boolean {
		const latest = this.latest;
		const state = this.undoState();
		if (!latest || state?.state !== 'ready' || this.turns.find((t) => t.messageId === messageId)?.turnId !== latest.turnId) return false;
		const running = latest.record
			.undo()
			.catch((error: unknown): UndoOutcome => ({ kind: 'refused', text: `Undo refused, nothing was changed: ${error instanceof Error ? error.message : String(error)}.` }))
			.then(async (outcome) => {
				if (outcome.kind !== 'refused' && this.latest === latest) this.latest = null;
				// step: the chat closed while Undo ran and went with it, so the note goes in the session's own rows, saved for a reopened tab and the next turn
				if (this.closed) {
					const row: ChatMessage = { id: this.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1, text: outcome.text, sender: 'system', timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
					await this.persist([...this.messages, row]).catch((err) => {
						console.log('[AgentSession] could not save the Undo note', err);
					});
				}
				undoing.delete(this.sessionId);
				handlers.note?.(outcome.text);
				this.changed();
			});
		undoing.set(this.sessionId, running);
		this.changed();
		return true;
	}

	/**
	 * Sends a message once no Undo of this conversation runs, so the turn it opens starts after Undo's
	 * note row and reads it. A message held by a conversation that closed first is dropped.
	 */
	afterUndo(send: () => void): void {
		const running = undoing.get(this.sessionId);
		if (!running) return send();
		// step: a conversation closed while Undo ran took its chat with it, so the held message goes nowhere;
		// a tab drawn again in the meantime still sends it, to the same chat
		const go = (): void => {
			if (!this.closed) send();
		};
		void running.then(go, go);
	}

	/**
	 * Handles a press on a turn's card: a file link opens the file, Open Variables opens Variables,
	 * and a choice or Continue sends its text as the reply, once, to the open request only.
	 *
	 * @returns Whether the press did anything.
	 */
	cardAction(messageId: number, action: ChatCardAction, handlers: CardActionHandlers): boolean {
		if (action.kind === 'file') {
			handlers.openFile(action.path);
			return true;
		}
		if (action.id === OPEN_VARIABLES) {
			handlers.openVariables();
			return true;
		}
		if (action.id === UNDO) return this.undoFrom(messageId, handlers);
		const request = this.turns.find((t) => t.messageId === messageId)?.request;
		if (!request || request.answeredBy !== undefined || this.claimed === request.id) return false;
		const reply = request.kind === 'question' ? request.choices?.find((_, i) => choiceAction(i) === action.id) : action.id === CONTINUE ? CONTINUE_TEXT : undefined;
		if (reply === undefined) return false;
		this.claimed = request.id;
		handlers.send(reply);
		return true;
	}

	/**
	 * Persists the conversation (session file + catalog row). The session saves
	 * its chat itself after each completed exchange.
	 * Every row, card, record and the title pass through redactText, so a pasted key is stored
	 * only as `[redacted]` (the history a turn sends is redacted in run.ts).
	 *
	 * @param messages - The full conversation as rendered by the chat hook.
	 */
	async save(messages: ChatMessage[]): Promise<void> {
		await this.persist(messages);
	}

	/** Writes the session file (version 2: rows with cards, turns, runs, the model); writes land in the order asked. */
	private async persist(messages: ChatMessage[]): Promise<void> {
		const rows = this.withCards(messages, false).map((m) => ({ ...m, text: redactText(m.text), ...(m.card ? { card: redactDeep(m.card) } : {}) }));
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
			model: this.chosen,
		};
		const write = this.saving.then(() => saveSession(file));
		this.saving = write.catch(() => undefined);
		await write;
		this.stored = true;
	}
}
