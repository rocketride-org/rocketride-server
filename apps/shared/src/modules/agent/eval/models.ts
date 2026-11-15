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
// MODELS: what answers the model pipeline's chat in L1 and L2
// =============================================================================

/**
 * The agent asks its model through its model pipeline's `chat` (modelEngine.ts). On the fake engine
 * that chat comes here, and both layers answer with the engine's own pipeline result. Everything
 * from modelEngine.ts's readAnswer up (the session, both adapters, the done gate) then runs in L1
 * exactly as it ran live.
 *
 * - L1, `ReplayModel`: the answers a live trial got, in order. A question the recording does not
 *   have next (another kind, or one answering other call ids) ends the turn and marks the replay as
 *   diverged, which scores as an error, never as a pass.
 * - L2, `engineModel`: the product's own Question, on the product's own model pipeline, on a real
 *   engine. The provider keys are that engine's Variables; this process never holds them.
 */

import type { PIPELINE_RESULT, PipelineConfig, Question, RocketRideClient } from 'rocketride';

import type { StandinModel } from './engine';

/** One model answer as a live trial got it. */
export interface RecordedAnswer {
	/** The wave it was asked in, for a reader; replay does not match on it. */
	wave: number;
	/** 'turn': a native turn. 'text': a text question (the text adapter, or its conclusion). */
	asked: 'turn' | 'text';
	/** The call ids the question's last message answers, in order; [] for text. */
	answering: string[];
	/** The engine's answer entry as it came: `{message, stopReason, tokens}`, `{error, tokens?}`, or text. */
	entry: unknown;
}

/** One recorded turn: its request and the answers it got. */
export interface RecordedTurn {
	request: string;
	answers: RecordedAnswer[];
}

/** What a question is, as a recording matches it. */
export function askedOf(question: Question): Pick<RecordedAnswer, 'asked' | 'answering'> {
	const last = question.messages.at(-1);
	if (!last) return { asked: 'text', answering: [] };
	const blocks = typeof last.content === 'string' ? [] : last.content;
	return { asked: 'turn', answering: blocks.flatMap((block) => (block.type === 'tool_result' ? [block.callId] : [])) };
}

/** A pipeline result holding one answer entry, as the model pipeline's answers lane returns it. */
function answered(entry: unknown): PIPELINE_RESULT {
	return { name: 'eval-replay', path: '', objectId: 'eval-replay', result_types: { answers: 'answers' }, answers: [entry] };
}

// =============================================================================
// L1: REPLAY
// =============================================================================

const NO_REPLY = 'The replay has no recorded reply here.';

function said(a: Pick<RecordedAnswer, 'asked' | 'answering'>): string {
	return a.asked === 'turn' ? `a turn answering [${a.answering.join(', ')}]` : 'a text question';
}

/** Plays a recording back, one turn at a time. */
export class ReplayModel {
	private turn = -1;
	private at = 0;
	/** Answers handed out, over the whole trial. */
	consumed = 0;
	/** Why the replay left its recording, or null. */
	diverged: string | null = null;

	constructor(private readonly turns: RecordedTurn[]) {}

	/** Answers in the recording, over the whole trial. */
	get recorded(): number {
		return this.turns.reduce((n, t) => n + t.answers.length, 0);
	}

	/** The recorded request for a turn, or null past the last one. */
	request(turn: number): string | null {
		return this.turns[turn]?.request ?? null;
	}

	/** Starts the next turn. */
	beginTurn(): void {
		this.turn++;
		this.at = 0;
	}

	/** Answers of the current turn not yet handed out. */
	left(): number {
		return (this.turns[this.turn]?.answers.length ?? 0) - this.at;
	}

	/** Answers one question from the recording, or ends the turn when the recording has nothing that fits. */
	answer: StandinModel = async (question) => {
		const asked = askedOf(question);
		const next = this.turns[this.turn]?.answers[this.at];
		if (!next || next.asked !== asked.asked || next.answering.join() !== asked.answering.join()) {
			this.diverged ??= `turn ${this.turn + 1}: the loop asked ${said(asked)} at answer ${this.at + 1}, and the recording has ${next ? said(next) : 'nothing'} there`;
			return answered(asked.asked === 'turn' ? { message: { role: 'assistant', content: [{ type: 'text', text: NO_REPLY }] }, stopReason: 'end_turn' } : JSON.stringify({ done: true, answer: NO_REPLY }));
		}
		this.at++;
		this.consumed++;
		return answered(next.entry);
	};
}

// =============================================================================
// L2: THROUGH A REAL ENGINE
// =============================================================================

/**
 * The model pipeline's chat on a real engine. Each pipeline the product starts is started there
 * once, with the same project_id, and every question goes to it as the product built it.
 *
 * @param engine - A client connected to an engine whose Variables hold the provider keys.
 * @param o.tools - False: answer every turn `tools_unsupported` without asking the engine, as a node
 *   with no tool calling does, so the product falls back and the trial runs the text adapter on a
 *   real model.
 * @returns The chat, and `close`, which ends the started pipelines and disconnects.
 */
export function engineModel(engine: RocketRideClient, o: { tools: boolean }): { answer: StandinModel; close: () => Promise<void> } {
	const tokens = new Map<string, Promise<string>>();
	const tokenOf = (pipeline: Record<string, unknown>): Promise<string> => {
		const id = String(pipeline.project_id);
		const cached = tokens.get(id);
		if (cached) return cached;
		const started = engine.use({ pipeline: pipeline as unknown as PipelineConfig, useExisting: true }).then((r) => r.token);
		tokens.set(id, started);
		started.catch(() => tokens.delete(id));
		return started;
	};
	return {
		answer: async (question, pipeline) => {
			if (!o.tools && question.messages.length) return answered({ error: { code: 'tools_unsupported', message: 'the eval runs this model on the text adapter (--adapter text)' } });
			return engine.chat({ token: await tokenOf(pipeline), question });
		},
		close: async () => {
			for (const token of tokens.values()) {
				try {
					await engine.terminate(await token);
				} catch {
					// it never started, or already ended
				}
			}
			await engine.disconnect();
		},
	};
}
