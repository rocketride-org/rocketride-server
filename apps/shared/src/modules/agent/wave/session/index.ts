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
// MODEL SESSION — the one conversation a turn holds with its model
// =============================================================================

/**
 * A session owns the turn's conversation with the model. The loop never sees a message: it says
 * what came of each reply and gets the next one back, already read. Behind `next` and `conclude`
 * the session decides everything about talking to a model: the adapter (native tool calling, or
 * the text question with a JSON reply once the model refuses tools), the call ids that tie results
 * to calls, the answers to calls the loop never gets, one retry of an unusable reply, continuing a
 * reply cut at the output limit, one fresh retry of a failed send, the send time limit, Stop and
 * the meter. A stop, the cost limit and a failed model come back as values, so the loop handles
 * every outcome in one exhaustive switch. native.ts and text.ts are its two adapters; nothing
 * outside this folder imports them.
 */

import { ModelFailure, type ChatModel, type KeyTrouble, type ModelRequest, type ModelResponse } from '../../model';
import { CostLimitError, type Meter, type RequestSize } from '../../usage';
import type { HistoryTurn, PromptPrefix, ResultEntry, ToolCall } from '../plan';
import { nativeConversation } from './native';
import { textConversation } from './text';

// =============================================================================
// WHAT THE LOOP SEES
// =============================================================================

/** A call's id in this turn's conversation. Only the adapters mint one, so a result can only answer a call the model made. */
export type CallId = string & { readonly __callId: unique symbol };

/** A call the model asked for, ready for the loop to run. */
export interface PlannedCall extends ToolCall {
	readonly id: CallId;
}

/** What one call of the last reply came to: the entry the loop recorded for it. An entry with `error` is an error result. */
export interface CallResult {
	readonly id: CallId;
	readonly entry: ResultEntry;
}

/**
 * What the loop tells the model before the next reply. After a `calls` reply, `results` answers
 * each of its calls once, in any order; otherwise it is empty. Notes are plain text the model reads
 * after the results, in order: refusals from the done gate, late returns, the user's mid-run
 * messages, files someone else changed.
 */
export interface Round {
	readonly results: readonly CallResult[];
	readonly notes: readonly string[];
}

/** A round with nothing to say. */
export const NO_ROUND: Round = { results: [], notes: [] };

/** An ask that got no reply to act on. */
export type Interrupted =
	/** The run's signal aborted while the model was asked; whatever it answers later is dropped. */
	| { readonly kind: 'stopped' }
	/** The meter refused the request before it was sent. */
	| { readonly kind: 'cost_limit'; readonly error: CostLimitError }
	/** The model failed after its one fresh retry (a ModelFailure, or anything else that threw). */
	| { readonly kind: 'failed'; readonly error: Error };

/**
 * The model's next reply, read. A reply either calls tools or answers, never both: done means the
 * model ended its turn with no tool calls.
 */
export type ModelReply =
	/** Run these. `thought` is the text the model wrote beside them. */
	| { readonly kind: 'calls'; readonly thought: string; readonly calls: readonly [PlannedCall, ...PlannedCall[]] }
	/** The model ended its turn; `answer` is its text, memory references not yet filled in. */
	| { readonly kind: 'answer'; readonly thought: string; readonly answer: string }
	/** Neither, even after the session sent it back once with what was wrong. */
	| { readonly kind: 'unusable'; readonly thought: string; readonly problems: readonly string[] }
	| Interrupted;

/** The final answer asked for when the run stops unfinished. `answer` is '' when the model wrote none. */
export type Conclusion = { readonly kind: 'answer'; readonly answer: string } | Interrupted;

/** How the session talks to its model: native first, text once the model refuses tools. */
export type Adapter = 'native' | 'text';

/** One turn's conversation with its model. */
export interface ModelSession {
	/** The adapter the session talks through now, for the run's log line. */
	readonly adapter: Adapter;
	/**
	 * Tells the model what came of its last reply, then asks for the next one.
	 *
	 * @throws Only for a broken contract: a result for a call the last reply did not make, or a call left unanswered.
	 */
	next(round: Round): Promise<ModelReply>;
	/**
	 * Tells the model what came of its last reply, then asks for a final answer with no tool calls
	 * from everything in the conversation. Neither verb may follow it.
	 */
	conclude(round: Round): Promise<Conclusion>;
}

// =============================================================================
// OPENING
// =============================================================================

/** What a turn's session is opened with. */
export interface SessionOptions {
	/** The turn's model: its name for the meter, and the send that reaches the engine. */
	model: ChatModel;
	/** Role, instructions and tools: identical on every request of the run. */
	prefix: PromptPrefix;
	/** Earlier turns of the chat, as user text and final answers, oldest first. */
	history: readonly HistoryTurn[];
	/** What the user asked this turn, redacted. */
	request: string;
	/** Aborted when the user stops the run: a send that fails after it does not retry, so it cannot restart the task the next turn is about to use. */
	signal: AbortSignal;
	/** Reserves each send before it goes, the retry included, and ends it with what the provider counted. */
	meter?: Meter;
	/** Hears a send's final failure when a key is the cause. The loop swallows failures once it has gathered something, so it cannot tell the run. */
	onKeyTrouble?: (trouble: KeyTrouble) => void;
	/** How long one send waits for an answer (default MODEL_CALL_LIMIT_MS). */
	limitMs?: number;
}

/**
 * How long one send waits for an answer. A provider sometimes holds the connection and never
 * answers, and nothing below the agent gives up. The slowest real answer seen was 65 s, and slower
 * models write big files more slowly.
 */
export const MODEL_CALL_LIMIT_MS = 180_000;

/** How many times one reply is continued after the output limit before the session takes it as it stands. */
export const MAX_CONTINUATIONS = 2;

/** Opens a turn's session. Sync, no I/O: nothing is sent until the first `next`. */
export function openSession(o: SessionOptions): ModelSession {
	return new Session(o);
}

// =============================================================================
// INSIDE — the adapter contract, for native.ts and text.ts only
// =============================================================================

/** What every adapter starts its conversation from. */
export interface Opening {
	readonly prefix: PromptPrefix;
	readonly history: readonly HistoryTurn[];
	readonly request: string;
}

/** What a conversation asks the session to send, and its size for the meter. */
export interface Outgoing {
	readonly request: ModelRequest;
	readonly size: RequestSize;
}

/**
 * One answer as an adapter read it, before the session's retry and continuation rules. `cut` is
 * true when the provider stopped at the output limit. Runnable calls are never cut: a reply cut
 * with calls in it reads as `unusable`, and the conversation answers those calls itself without
 * running them, since their arguments may be cut short.
 */
export type Reading = { readonly kind: 'calls'; readonly thought: string; readonly calls: readonly [PlannedCall, ...PlannedCall[]] } | { readonly kind: 'answer'; readonly thought: string; readonly answer: string; readonly cut: boolean } | { readonly kind: 'unusable'; readonly thought: string; readonly problems: readonly string[]; readonly cut: boolean };

/**
 * One adapter's copy of the turn's conversation. It alone holds the messages, so nothing else can
 * break the pairing of calls and results or the alternation the provider needs.
 */
export interface Conversation {
	readonly adapter: Adapter;
	/**
	 * Adds what answers the last reply: a result for each of its calls (the loop's, or the
	 * conversation's own for a call the loop never got), then the notes.
	 *
	 * @throws For a result whose id the last reply did not make, a result given twice, or a call left unanswered.
	 */
	answer(round: Round): void;
	/** Sends the last, unusable reply back once: answers its calls, then says what was wrong. */
	retry(problems: readonly string[]): void;
	/** Asks the model to go on with an answer it cut short at the output limit. */
	resume(): void;
	/** From now on, asks for the final answer with no tool calls. */
	conclude(): void;
	/** The request to send now. */
	request(): Outgoing;
	/** Reads an answer to `request()` and adds the model's message to the conversation. */
	take(response: ModelResponse): Reading;
}

// =============================================================================
// THE SESSION
// =============================================================================

/** Thrown inside a send when the run is stopped while the model is asked. */
class RunStopped extends Error {}

class Session implements ModelSession {
	private conversation: Conversation;
	/** Until the first answer is taken, the round the turn opened with, so a refusal of tools can start the turn again as text. */
	private stage: { readonly opened?: Round } | 'answered' = {};
	private concluded = false;

	constructor(private readonly o: SessionOptions) {
		this.conversation = nativeConversation(this.opening());
	}

	get adapter(): Adapter {
		return this.conversation.adapter;
	}

	async next(round: Round): Promise<ModelReply> {
		this.put(round);
		const reply = await this.reply();
		if (reply.kind !== 'unusable') return reply;
		this.conversation.retry(reply.problems);
		return this.reply();
	}

	async conclude(round: Round): Promise<Conclusion> {
		this.put(round);
		this.concluded = true;
		this.conversation.conclude();
		const reply = await this.reply();
		switch (reply.kind) {
			case 'answer':
				return { kind: 'answer', answer: reply.answer };
			case 'calls':
			case 'unusable':
				return { kind: 'answer', answer: '' };
			default:
				return reply;
		}
	}

	private opening(): Opening {
		return { prefix: this.o.prefix, history: this.o.history, request: this.o.request };
	}

	private put(round: Round): void {
		if (this.concluded) throw new Error('A model session takes nothing after conclude.');
		if (this.stage !== 'answered' && this.stage.opened === undefined) this.stage = { opened: round };
		this.conversation.answer(round);
	}

	/** One reply: send, fall back to text on a refusal of tools, and continue a reply cut at the output limit. */
	private async reply(): Promise<ModelReply> {
		const parts: string[] = [];
		for (let continued = 0; ; ) {
			const sent = await this.send(this.conversation.request());
			switch (sent.kind) {
				case 'stopped':
				case 'cost_limit':
				case 'failed':
					return sent;
				case 'unsupported': {
					const refused = this.fallBack();
					if (refused) return refused;
					continue;
				}
			}
			const reading = this.conversation.take(sent);
			this.stage = 'answered';
			const more = continued < MAX_CONTINUATIONS;
			if (reading.kind === 'answer' && reading.cut && more) {
				parts.push(reading.answer);
				this.conversation.resume();
				continued++;
				continue;
			}
			// step: a reply cut inside a tool call keeps nothing; the conversation answered its calls, and the next reply stands alone
			if (reading.kind === 'unusable' && reading.cut && more) {
				parts.length = 0;
				this.conversation.answer(NO_ROUND);
				continued++;
				continue;
			}
			switch (reading.kind) {
				case 'calls':
					return reading;
				case 'answer':
					return { kind: 'answer', thought: reading.thought, answer: parts.join('') + reading.answer };
				case 'unusable':
					return { kind: 'unusable', thought: reading.thought, problems: reading.problems };
			}
		}
	}

	/**
	 * Starts the turn again as text. The engine refuses tools before any provider call, so a refusal
	 * can only come before the first answer; a later one is a broken engine.
	 */
	private fallBack(): Interrupted | undefined {
		if (this.stage === 'answered' || this.conversation.adapter === 'text') {
			return { kind: 'failed', error: new ModelFailure('This model cannot call tools.', { retryable: false, billed: false }) };
		}
		this.conversation = textConversation(this.opening());
		this.conversation.answer(this.stage.opened ?? NO_ROUND);
		if (this.concluded) this.conversation.conclude();
		return undefined;
	}

	/**
	 * One request through the meter, the time limit, Stop and one fresh retry. A retryable
	 * ModelFailure gets one fresh try, none after Stop, and a send with no answer inside the limit is
	 * one. A CostLimitError comes from reserve, before anything is sent.
	 */
	private async send(out: Outgoing): Promise<ModelResponse | Interrupted> {
		const { signal } = this.o;
		const started = performance.now();
		try {
			try {
				return await this.attempt(out, false);
			} catch (first) {
				if (!(first instanceof ModelFailure) || !first.retryable || signal.aborted) throw first;
				return await this.attempt(out, true);
			}
		} catch (error) {
			if (error instanceof RunStopped || signal.aborted) return { kind: 'stopped' };
			if (error instanceof CostLimitError) return { kind: 'cost_limit', error };
			if (error instanceof ModelFailure && error.key) this.o.onKeyTrouble?.(error.key);
			return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
		} finally {
			// step: the eval runs count this line
			console.log(`[agent] model call ${Math.round(performance.now() - started)} ms`);
		}
	}

	/**
	 * One send, reserved just before it goes. Real counts settle it, from an answer or from a failure
	 * the provider billed; a failure the provider cannot have billed releases it; an answer with no
	 * counts, a timeout, a thrown chat and a stop keep it.
	 */
	private async attempt(out: Outgoing, fresh: boolean): Promise<ModelResponse> {
		const held = this.o.meter?.reserve(out.size);
		try {
			const response = await answerOrStop(this.o.model.send(out.request, fresh ? { fresh } : undefined), this.o.limitMs ?? MODEL_CALL_LIMIT_MS, this.o.signal);
			if (response.kind === 'unsupported') held?.release();
			else if (response.tokens) held?.settle(response.tokens);
			else held?.keep();
			return response;
		} catch (error) {
			if (error instanceof ModelFailure && error.tokens) held?.settle(error.tokens);
			else if (error instanceof ModelFailure && !error.billed) held?.release();
			else held?.keep();
			throw error;
		}
	}
}

/**
 * Settles as `sending` does, fails retryable once `ms` pass with no answer, or rejects with
 * RunStopped once the signal aborts. Whatever `sending` does after either is dropped: the fresh
 * retry ends the stuck task.
 */
function answerOrStop(sending: Promise<ModelResponse>, ms: number, signal: AbortSignal): Promise<ModelResponse> {
	return new Promise((resolve, reject) => {
		const stop = (): void => {
			clearTimeout(timer);
			reject(new RunStopped());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop);
			// step: the eval runs count this line
			console.log(`[agent] model call had no answer in ${Math.round(ms / 1000)} s`);
			reject(new ModelFailure(`The model did not answer in ${Math.round(ms / 1000)} s.`, { retryable: true, billed: true }));
		}, ms);
		if (signal.aborted) stop();
		else signal.addEventListener('abort', stop, { once: true });
		sending.then(
			(response) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', stop);
				resolve(response);
			},
			(error: unknown) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', stop);
				reject(error);
			}
		);
	});
}
