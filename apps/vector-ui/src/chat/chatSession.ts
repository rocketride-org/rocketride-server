// =============================================================================
// MIT License
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
// VECTOR-UI — CHAT SESSION (one connection's conversation)
// =============================================================================
//
// The state behind the console's chat (R5), kept per connection so switching
// between the Console and Map tabs does not lose it; useVectorChat.ts renders
// it. Rules:
//
//   - One question in flight; a second send while one is open is refused with
//     a sentence (never queued, never retried).
//   - Questions are trimmed and at most CHAT_MAX_CHARS long.
//   - The console waits CHAT_TIMEOUT_MS; then, or after "Stop waiting", the
//     turn says the pipeline may still be answering. The generation ticket
//     drops an answer that arrives after that, or after a reset.
//   - History holds the questions only (for recall), newest first.
// =============================================================================

import { createGeneration } from 'shared/explorer';
import type { IGenerationTicket } from 'shared/explorer';
import { CHAT_TIMEOUT_MS, chatErrorSentence, parseChatResult, summariseSources, validateQuestion } from '../vector/chatResult';
import type { ChatErrorSentence, ParsedChatAnswer } from '../vector/chatResult';

/** Questions kept for recall. */
export const HISTORY_MAX = 50;

/** What a turn says after "Stop waiting". */
export const STOPPED_SENTENCE = 'Stopped waiting. The pipeline may still be answering; there is no way to cancel it from here.';

/** One question and what came of it. */
export interface ChatTurn {
	id: number;
	question: string;
	/** objectIds the question was restricted to ("Ask about these only"), or null. */
	scope: readonly string[] | null;
	status: 'asking' | 'answered' | 'failed' | 'timeout' | 'stopped';
	answer: ParsedChatAnswer | null;
	error: ChatErrorSentence | null;
	/** Epoch ms. */
	askedAt: number;
	answeredAt: number | null;
}

/** What the chat panel renders. */
export interface ChatState {
	turns: readonly ChatTurn[];
	asking: boolean;
	/** Why the last send was refused, until the next send. */
	notice: string | null;
}

/** What the session needs from the connection. Read on every use. */
export interface ChatDeps {
	/** The chat role's ask (the channel enforces the wait and drops expired tickets). */
	ask(question: unknown, options: { timeoutMs: number; generation: IGenerationTicket }): Promise<Record<string, unknown>>;
	/** Build the SDK Question for the text (restricted to `scope` when given). */
	makeQuestion(text: string, scope: readonly string[] | null): unknown;
	now(): number;
	/** An answer arrived (the panel highlights its sources). */
	onAnswer?(turn: ChatTurn): void;
	announce(message: string): void;
}

/**
 * What the end of the thread shows: it changes when a question is posted and
 * again when that question ends (answered, failed, timed out or stopped), so
 * the panel scrolls to an answer when it arrives, not only to the question.
 *
 * @param turns - The thread.
 * @returns A key that changes whenever the end of the thread does.
 */
export function threadScrollKey(turns: readonly ChatTurn[]): string {
	const last = turns[turns.length - 1];
	return last === undefined ? '0' : `${turns.length}:${last.id}:${last.status}`;
}

/** One connection's conversation. */
export interface ChatSession {
	getState(): ChatState;
	subscribe(listener: () => void): () => void;
	/** Ask a question. Resolves when it is answered, fails, or is refused. */
	send(text: string, scope: readonly string[] | null): Promise<void>;
	/** Stop waiting for the open question (it may still be answered on the server). */
	stopWaiting(): void;
	/** Questions asked, newest first. */
	history(): string[];
	/** Forget the conversation and the history. */
	clear(): void;
	/** Forget everything for good (identity change, connection closed). */
	dispose(): void;
}

/**
 * Create a session.
 *
 * @param deps - The connection's seams.
 * @returns The session.
 */
export function createChatSession(deps: ChatDeps): ChatSession {
	const generation = createGeneration();
	const listeners = new Set<() => void>();
	let state: ChatState = { turns: [], asking: false, notice: null };
	let questions: string[] = [];
	let turnCounter = 0;
	let disposed = false;

	/**
	 * Replace the state and notify.
	 *
	 * @param patch - Changed fields.
	 */
	const set = (patch: Partial<ChatState>): void => {
		if (disposed) return;
		state = { ...state, ...patch };
		for (const listener of [...listeners]) listener();
	};

	/**
	 * Change one turn.
	 *
	 * @param id - The turn.
	 * @param patch - Changed fields.
	 * @param asking - The new `asking` flag.
	 */
	const finish = (id: number, patch: Partial<ChatTurn>, asking: boolean): void => {
		set({ turns: state.turns.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)), asking });
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async send(text, scope) {
			if (disposed) return;
			if (state.asking) {
				set({ notice: 'Wait for the answer to the current question.' });
				return;
			}
			const checked = validateQuestion(text);
			if (!checked.ok) {
				set({ notice: checked.reason });
				return;
			}
			const question = checked.text;
			const scoped = scope !== null && scope.length > 0 ? [...scope] : null;
			questions = [question, ...questions.filter((entry) => entry !== question)].slice(0, HISTORY_MAX);
			turnCounter += 1;
			const id = turnCounter;
			const ticket = generation.next();
			set({ turns: [...state.turns, { id, question, scope: scoped, status: 'asking', answer: null, error: null, askedAt: deps.now(), answeredAt: null }], asking: true, notice: null });

			let wire: Record<string, unknown>;
			try {
				wire = await deps.ask(deps.makeQuestion(question, scoped), { timeoutMs: CHAT_TIMEOUT_MS, generation: ticket });
			} catch (error) {
				if (disposed || !ticket.isCurrent()) return;
				const sentence = chatErrorSentence(error);
				if (sentence.kind === 'stale') return;
				finish(id, { status: sentence.kind === 'timeout' ? 'timeout' : 'failed', error: sentence, answeredAt: deps.now() }, false);
				deps.announce(sentence.message);
				return;
			}
			if (disposed || !ticket.isCurrent()) return;
			const answer = parseChatResult(wire);
			finish(id, { status: 'answered', answer, answeredAt: deps.now() }, false);
			const turn = state.turns.find((candidate) => candidate.id === id);
			if (turn) deps.onAnswer?.(turn);
			const sources = summariseSources(answer.sources).count;
			deps.announce(answer.empty ? 'The pipeline answered without text or sources.' : `Answer received with ${sources === 1 ? '1 source' : `${sources} sources`}.`);
		},
		stopWaiting() {
			if (!state.asking) return;
			generation.invalidate();
			const open = state.turns.find((turn) => turn.status === 'asking');
			if (open) finish(open.id, { status: 'stopped', error: { kind: 'timeout', message: STOPPED_SENTENCE }, answeredAt: deps.now() }, false);
			else set({ asking: false });
			deps.announce(STOPPED_SENTENCE);
		},
		history: () => [...questions],
		clear() {
			generation.invalidate();
			questions = [];
			set({ turns: [], asking: false, notice: null });
		},
		dispose() {
			generation.invalidate();
			questions = [];
			state = { turns: [], asking: false, notice: null };
			for (const listener of [...listeners]) listener();
			disposed = true;
		},
	};
}
