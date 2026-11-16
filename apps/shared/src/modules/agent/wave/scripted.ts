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
// SCRIPTED MODEL — a ChatModel that plays a script, for the loop and toolkit tests
// =============================================================================

/**
 * Test support, never imported by product code. It fakes the outermost seam, ChatModel.send, so
 * a test drives the real session, the real adapter and the real loop. One script plays under
 * either adapter: each step is written as a native turn or as JSON text, whichever the request
 * asks for. 'rocketride' is stubbed in tests, so the client's own turn checks never run; this fake
 * checks the turn rules a provider enforces on every send instead.
 */

import type { AssistantMessage, Message, Tool, ToolCallBlock } from 'rocketride';

import type { ChatModel, ModelRequest, ModelResponse } from '../model';
import type { Tokens } from '../usage';

/** One reply of a script, adapter-neutral. */
export type Reply =
	/** Call these tools, with a thought beside them. */
	| { readonly calls: ReadonlyArray<readonly [tool: string, args?: Record<string, unknown>]>; readonly thought: string }
	/** End the turn with this answer. */
	| { readonly answer: string }
	/** This reply, cut at the output limit: a native turn stops at max_tokens, a text reply is cut mid-JSON. */
	| { readonly cut: Reply }
	/** Exactly this text: a text reply as written, or a native answer. */
	| { readonly text: string };

/** One step of a script: a reply, an error the send throws, or either made from the request it answers. */
export type Step = Reply | Error | ((request: ModelRequest) => Reply | Error);

/** A reply asking for tool calls. */
export const plan = (...calls: Array<readonly [string, Record<string, unknown>?]>): Reply => ({ calls, thought: 'working' });

/** A reply that finishes with `answer`. */
export const done = (answer: string): Reply => ({ answer });

/** `step`, cut at the output limit. */
export const cut = (reply: Reply): Reply => ({ cut: reply });

/** Exactly this text. */
export const raw = (text: string): Reply => ({ text });

/** What every scripted native answer reports, so a test can see real tokens reach the meter. */
export const SCRIPTED_TOKENS: Tokens = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };

/** A scripted model, and what it was asked. */
export interface ScriptedModel extends ChatModel {
	/** Every request sent, in order. */
	readonly requests: ModelRequest[];
	/** The request each script step answered, in order; the same under either adapter. */
	readonly asked: ModelRequest[];
	/** Every turn rule a request broke, as the send that broke it was refused. */
	readonly broken: string[];
}

/**
 * A ChatModel that answers each send with the next step of `script`.
 *
 * @param o.native - False: answer every turn request `unsupported` without using a step, as a node
 *   with no tool calling does, so the session falls back and the script plays as text.
 * @param o.onSend - Runs before a step answers (a user message arriving mid-run, a slow model).
 */
export function scriptedModel(script: Step[], o: { native?: boolean; onSend?: (step: number) => void | Promise<void> } = {}): ScriptedModel {
	const requests: ModelRequest[] = [];
	const asked: ModelRequest[] = [];
	const broken: string[] = [];
	let calls = 0;
	const send = async (request: ModelRequest): Promise<ModelResponse> => {
		requests.push(request);
		const problems = request.kind === 'turn' ? turnProblems(request) : [];
		if (problems.length) {
			broken.push(...problems);
			throw new Error(`scriptedModel: the request broke a turn rule: ${problems.join('; ')}`);
		}
		if (request.kind === 'turn' && o.native === false) return { kind: 'unsupported' };
		const next = script.shift();
		if (next === undefined) throw new Error('scriptedModel: no reply left');
		await o.onSend?.(asked.length);
		asked.push(request);
		const step = typeof next === 'function' ? next(request) : next;
		if (step instanceof Error) throw step;
		if (request.kind === 'text') return { kind: 'text', text: textOf(step) };
		const { message, stop } = turnOf(step, () => `c${++calls}`);
		return { kind: 'turn', message, stop, tokens: SCRIPTED_TOKENS };
	};
	return { name: 'scripted-model', send, requests, asked, broken };
}

/** A reply as a native turn. */
function turnOf(step: Reply, id: () => string): { message: AssistantMessage; stop: 'end_turn' | 'tool_use' | 'max_tokens' } {
	if ('cut' in step) return { ...turnOf(step.cut, id), stop: 'max_tokens' };
	if ('answer' in step) return { message: { role: 'assistant', content: [{ type: 'text', text: step.answer }] }, stop: 'end_turn' };
	if ('text' in step) return { message: { role: 'assistant', content: [{ type: 'text', text: step.text }] }, stop: 'end_turn' };
	const blocks: ToolCallBlock[] = step.calls.map(([tool, args]) => ({ type: 'tool_call', id: id(), name: tool, args: args ?? {} }));
	return { message: { role: 'assistant', content: [...(step.thought ? [{ type: 'text' as const, text: step.thought }] : []), ...blocks] }, stop: 'tool_use' };
}

/** A reply as the JSON a text model writes. */
function textOf(step: Reply): string {
	if ('cut' in step) {
		const whole = textOf(step.cut);
		return whole.slice(0, Math.ceil(whole.length / 2));
	}
	if ('answer' in step) return JSON.stringify({ thought: 'finishing', done: true, answer: step.answer });
	if ('text' in step) return step.text;
	return JSON.stringify({ thought: step.thought, tool_calls: step.calls.map(([tool, args]) => ({ tool, args: args ?? {} })) });
}

// =============================================================================
// TURN RULES — what a provider refuses
// =============================================================================

/**
 * The rules a provider enforces on a turn: messages start with the user's, roles alternate, the
 * last message is the user's, nothing is empty, and every tool call is answered exactly once in the
 * user message right after it, results before any text. The eval's fake engine checks them too.
 */
export function turnProblems(request: { readonly messages: readonly Message[]; readonly tools: readonly Tool[] }): string[] {
	const problems: string[] = [];
	const { messages } = request;
	const names = request.tools.map((tool) => tool.name);
	if (new Set(names).size !== names.length) problems.push('tool names are not unique');
	if (messages[0]?.role !== 'user') problems.push("the first message is not the user's");
	if (messages.at(-1)?.role !== 'user') problems.push("the last message is not the user's");
	messages.forEach((message, i) => {
		if (i > 0 && message.role === messages[i - 1].role) problems.push(`messages ${i - 1} and ${i} are both the ${message.role}'s`);
		const content = blocksOf(message);
		if (!content.length || content.some((block) => block.type === 'text' && !block.text?.trim())) problems.push(`message ${i} is empty or holds empty text`);
		const asked = message.role === 'assistant' ? content.flatMap((block) => (block.type === 'tool_call' ? [block.id] : [])) : [];
		const after = messages[i + 1];
		const answered = after?.role === 'user' ? blocksOf(after).flatMap((block) => (block.type === 'tool_result' ? [block.callId] : [])) : [];
		if (message.role === 'assistant' && [...asked].sort().join() !== [...answered].sort().join()) problems.push(`the calls of message ${i} are not each answered once in message ${i + 1}`);
		if (message.role === 'user') {
			const firstText = content.findIndex((block) => block.type === 'text');
			const lastResult = content.map((block) => block.type).lastIndexOf('tool_result');
			if (firstText !== -1 && lastResult > firstText) problems.push(`message ${i} has text before a tool result`);
			const before = messages[i - 1];
			const made = before?.role === 'assistant' ? blocksOf(before).flatMap((block) => (block.type === 'tool_call' ? [block.id] : [])) : [];
			if (content.some((block) => block.type === 'tool_result' && !made.includes(block.callId))) problems.push(`message ${i} answers a call the message before it did not make`);
		}
	});
	return problems;
}

/** A message's content as blocks. */
function blocksOf(message: Message): Array<{ type: string; text?: string; id?: string; callId?: string } & Record<string, unknown>> {
	if (typeof message.content === 'string') return message.content ? [{ type: 'text', text: message.content }] : [];
	return message.content as unknown as Array<{ type: string } & Record<string, unknown>>;
}

// =============================================================================
// READING A REQUEST — under either adapter
// =============================================================================

/** One result entry as the model read it: its tool, then what the loop recorded (key, summary or error, note). */
export type ShownResult = { tool: string; key?: string; summary?: string; error?: string; note?: string } & Record<string, unknown>;

/** Matches a text step of the transcript and the results it shows. */
const TEXT_STEP = /^Step \d+\./;
const TEXT_RESULTS = '\nTool results:\n';

/**
 * Every result a request shows the model, oldest first, under either adapter. A result the session
 * wrote itself (a call it did not run) shows as its text under `error`.
 */
export function resultsIn(request: ModelRequest): ShownResult[] {
	if (request.kind === 'text') {
		return request.spec.context.flatMap((item) => {
			const at = item.indexOf(TEXT_RESULTS);
			return TEXT_STEP.test(item) && at !== -1 ? (JSON.parse(item.slice(at + TEXT_RESULTS.length)) as ShownResult[]) : [];
		});
	}
	const tools = new Map<string, string>();
	const shown: ShownResult[] = [];
	for (const message of request.messages) {
		for (const block of blocksOf(message)) {
			if (block.type === 'tool_call') tools.set(String(block.id), String(block.name));
			if (block.type !== 'tool_result') continue;
			const tool = tools.get(String(block.callId)) ?? '';
			const content = String(block.content);
			try {
				shown.push({ ...(JSON.parse(content) as Record<string, unknown>), tool });
			} catch {
				shown.push({ tool, error: content });
			}
		}
	}
	return shown;
}

/**
 * The notes a request's newest user message holds, under either adapter: the loop's refusals, late
 * returns, the user's messages and other notes, and the session's own.
 */
export function notesIn(request: ModelRequest): string[] {
	if (request.kind === 'text') {
		const { context } = request.spec;
		const lastStep = context.findLastIndex((item) => TEXT_STEP.test(item));
		return context.slice(lastStep + 1);
	}
	const last = request.messages.at(-1);
	return last ? blocksOf(last).flatMap((block) => (block.type === 'text' ? [String(block.text)] : [])) : [];
}
