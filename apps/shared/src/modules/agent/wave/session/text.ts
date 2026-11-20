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
// TEXT CONVERSATION — the turn flattened into one text question, read with parseReply
// =============================================================================

/**
 * The adapter for every node without native tool calling: the engine refuses a tools question from
 * those with `tools_unsupported` before any provider call, and the session moves here. Each request
 * is today's text question: the tools described in the instructions, the JSON reply format, the
 * earlier turns as history, and the turn so far as context, one item per step (the model's thought,
 * then its tool results or its answer) followed by the notes after it. The model never sees call
 * ids: this file mints them, and shows results in call order.
 */

import type { ModelResponse } from '../../model';
import { TEXT_RESPONSE_FORMAT } from '../../prompts';
import type { QuestionSpec, ToolCall, ToolSpec } from '../plan';
import type { CallId, Conversation, Opening, Outgoing, PlannedCall, Reading, Round } from './index';

/** The question of every step's request. */
const NEXT_QUESTION = 'Plan the next set of tool calls, or set done=true if the goal is already met.';

/** The role of the conclusion: a plain answer, not a plan. */
const CONCLUDE_ROLE = 'You are a helpful assistant.';

const CONCLUDE_QUESTION = 'Based on the above, provide a complete and accurate final answer. The work stopped before it was finished: if something the goal needs is still unknown, say what is missing rather than guessing.';

/** Opens the text conversation. */
export function textConversation(o: Opening): Conversation {
	return new TextConversation(o);
}

class TextConversation implements Conversation {
	readonly adapter = 'text' as const;
	/** The turn so far as context items, oldest first. */
	private readonly items: string[] = [];
	/** The last reply with calls, until answer() shows it with its results. */
	private last: { readonly thought: string; readonly calls: readonly PlannedCall[]; readonly problems: readonly string[] } | undefined;
	private steps = 0;
	private minted = 0;
	private concluding = false;

	constructor(private readonly o: Opening) {}

	answer(round: Round): void {
		const byId = new Map(round.results.map((result) => [result.id, result.entry]));
		if (byId.size !== round.results.length) throw new Error('A call was answered twice.');
		const { last } = this;
		this.last = undefined;
		if (last) {
			const entries = last.calls.map((call) => {
				const entry = byId.get(call.id);
				if (!entry) throw new Error(`Call ${call.id} was left unanswered.`);
				byId.delete(call.id);
				return entry;
			});
			this.items.push(this.step(last.thought, `Tool results:\n${JSON.stringify(entries, null, 2)}`), ...last.problems.map((problem) => `Skipped: ${problem}`));
		}
		if (byId.size) throw new Error(`The last reply made no call ${[...byId.keys()].join(', ')}.`);
		this.items.push(...round.notes.filter((note) => note.trim()));
	}

	retry(problems: readonly string[]): void {
		this.answer({ results: [], notes: [`Your previous reply was not usable: ${problems.join('; ')}. Reply with exactly one of the two shapes in Response Format.`] });
	}

	resume(): void {
		throw new Error('A text reply carries no stop reason, so it is never cut.');
	}

	conclude(): void {
		this.concluding = true;
	}

	request(): Outgoing {
		const { prefix, history, request } = this.o;
		const asked = { history: [...history], goals: [request], context: [...this.items], expectJson: false };
		const spec: QuestionSpec = this.concluding
			? { ...asked, role: CONCLUDE_ROLE, instructions: [], question: CONCLUDE_QUESTION, cachePrefix: false }
			: {
					...asked,
					role: prefix.role,
					instructions: [...prefix.instructions, { title: 'Available Tools', text: catalog(prefix.tools) }, { title: 'Response Format', text: TEXT_RESPONSE_FORMAT }],
					question: NEXT_QUESTION,
					cachePrefix: true,
				};
		return { request: { kind: 'text', spec }, size: sizeOf(spec) };
	}

	take(response: ModelResponse): Reading {
		if (response.kind !== 'text') throw new Error(`A text conversation got a ${response.kind} answer.`);
		if (this.concluding) return { kind: 'answer', thought: '', answer: response.text, cut: false };
		const reply = parseReply(response.text);
		// step: done=true beside calls is not a finish, since a done reply has no calls; the calls run
		const [first, ...rest] = reply.toolCalls.map((call): PlannedCall => ({ ...call, id: `t${++this.minted}` as CallId }));
		if (first) {
			this.last = { thought: reply.thought, calls: [first, ...rest], problems: reply.problems };
			return { kind: 'calls', thought: reply.thought, calls: [first, ...rest] };
		}
		if (reply.done) {
			this.items.push(this.step(reply.thought, `Your answer:\n${reply.answer}`));
			return { kind: 'answer', thought: reply.thought, answer: reply.answer, cut: false };
		}
		return { kind: 'unusable', thought: reply.thought, problems: reply.problems, cut: false };
	}

	/** One step of the transcript: its number and the model's thought, then what came of it. */
	private step(thought: string, body: string): string {
		this.steps++;
		return `Step ${this.steps}.${thought.trim() ? ` ${thought}` : ''}\n${body}`;
	}
}

/** Writes the tool catalog: one compact JSON line per tool, memory.peek last. */
function catalog(tools: readonly ToolSpec[]): string {
	return tools.map(({ name, description, parameters }) => JSON.stringify({ name, description, parameters })).join('\n');
}

/** A question's size for the meter: role, instructions and history are the start the host can cache; goals, context and the question follow it. */
function sizeOf(q: QuestionSpec): { cachedChars: number; freshChars: number; cacheable: boolean } {
	const cachedChars = q.role.length + q.instructions.reduce((n, i) => n + i.title.length + i.text.length, 0) + q.history.reduce((n, turn) => n + turn.content.length, 0);
	const freshChars = q.goals.reduce((n, goal) => n + goal.length, 0) + q.context.reduce((n, item) => n + item.length, 0) + q.question.length;
	return { cachedChars, freshChars, cacheable: q.cachePrefix };
}

// =============================================================================
// REPLY — reading the model's reply and repairing what can be repaired
// =============================================================================

/**
 * Models get the reply format wrong in small, regular ways. parseReply finds
 * the JSON in the model's text and repairs those slips once, so the
 * conversation can trust the TextReply it gets. This is a port of Wave's
 * `normalize_plan` (`nodes/src/nodes/agent_rocketride/planner.py`); the problem
 * strings are worded for the model to act on, so they match it word for word.
 */

/** A text reply, read: its reasoning, its tool calls, and whether it asked to finish. */
export interface TextReply {
	/** Why the model chose this reply. */
	thought: string;
	/** The tool calls to run, in order. */
	toolCalls: ToolCall[];
	/** Whether the reply asked to finish with a non-blank answer and no call was dropped. */
	done: boolean;
	/** The final answer text, when done. */
	answer: string;
	/** Problems found while parsing the reply, worded for the model. */
	problems: string[];
}

// =============================================================================
// EXTRACTION — finding the JSON in the model's text
// =============================================================================

/** The first fenced block tagged json. */
const JSON_FENCE = /```json\b[ \t]*\r?\n?([\s\S]*?)```/i;

/** The first fenced block with no language tag. */
const PLAIN_FENCE = /```[ \t]*\r?\n([\s\S]*?)```/;

/** The outcome of reading JSON: the value, or a failure (JSON can itself be null). */
type Parsed = { ok: true; value: unknown } | { ok: false };

/** Whether a value is a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParse(source: string): Parsed {
	try {
		return { ok: true, value: JSON.parse(source) };
	} catch {
		return { ok: false };
	}
}

/**
 * Finds the JSON in a reply. Tries the first json fence, then the first plain
 * fence, then the whole text, then the text from the first `{` to the last `}`,
 * and keeps the first that parses. Trying on until one parses lets a fence cut
 * short by a ``` inside the answer text still be read.
 */
function extractJson(text: string): Parsed {
	const sources: string[] = [];
	const jsonFence = JSON_FENCE.exec(text);
	if (jsonFence) sources.push(jsonFence[1]);
	const plainFence = PLAIN_FENCE.exec(text);
	if (plainFence) sources.push(plainFence[1]);
	sources.push(text);
	const open = text.indexOf('{');
	const close = text.lastIndexOf('}');
	if (open !== -1 && close > open) sources.push(text.slice(open, close + 1));

	for (const source of sources) {
		const parsed = tryParse(source);
		if (parsed.ok) return parsed;
	}
	return { ok: false };
}

// =============================================================================
// REPAIR — one rule per slip
// =============================================================================

/** Names a parsed JSON value's type the way the model's reply is described to it. */
function jsonType(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}

/** Reads a field as text: absent is empty, text stays, anything else is written out. */
function asText(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Reads `done`, where the text "true" counts as true and "false" does not. */
function readDone(value: unknown): boolean {
	if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
	return value === true;
}

/** The keys of a call that name or describe it rather than hold an argument. */
const CALL_KEYS = new Set(['tool', 'name', 'function', 'args', 'arguments', 'input', 'parameters', 'id', 'type']);

/**
 * An entry's non-call keys are its arguments, values untouched. `name` is an argument whenever
 * `tool` is given, and `input`/`parameters` are when `plainText` says they hold plain text, since
 * a tool may take arguments by those names.
 */
function flatArgs(entry: Record<string, unknown>, plainText: boolean): Record<string, unknown> {
	const named = typeof entry.tool === 'string' && entry.tool !== '';
	return Object.fromEntries(
		Object.entries(entry).filter(([key]) => {
			if (key === 'name') return named;
			if (key === 'input' || key === 'parameters') return plainText;
			return !CALL_KEYS.has(key);
		})
	);
}

/**
 * Reads one `tool_calls` entry as `{tool, args}`, or returns null with a problem recorded. Unlike
 * Python Wave, which reads only `args` and OpenAI's `arguments`, it takes the first non-null of
 * `entry.args`, `fn.arguments`, `entry.input`, `fn.input`, `entry.parameters`, `fn.parameters`
 * (`fn` = the `function` object), parsing JSON text: Claude writes Anthropic's `{name, input}` and
 * sometimes flat arguments, which otherwise ran as `{}` and failed untraceably. With none, the
 * entry's other keys are the arguments (flatArgs). Non-JSON text in the entry's own
 * `input`/`parameters` with other keys beside it is an argument of that name, read flat.
 */
function readCall(entry: unknown, index: number, problems: string[]): ToolCall | null {
	if (!isObject(entry)) {
		problems.push(`tool_calls[${index}] was not an object`);
		return null;
	}
	const fn = isObject(entry.function) ? entry.function : entry;
	const name = entry.tool || fn.name;
	const sources = [entry.args, fn.arguments, entry.input, fn.input, entry.parameters, fn.parameters];
	// A null source counts as absent: "args": null beside OpenAI's arguments still means those arguments.
	const taken = sources.findIndex((value) => value !== undefined && value !== null);
	let args: unknown = taken === -1 ? flatArgs(entry, false) : sources[taken];
	if (typeof args === 'string') {
		const text = args.trim();
		const parsed: Parsed = text ? tryParse(text) : { ok: true, value: {} };
		const ownText = taken === 2 || taken === 4;
		if (ownText && !(text && parsed.ok && isObject(parsed.value)) && Object.keys(flatArgs(entry, false)).length) {
			args = flatArgs(entry, true);
		} else if (parsed.ok) {
			args = parsed.value;
		} else {
			problems.push(`tool_calls[${index}] arguments were not valid JSON`);
			return null;
		}
	}
	if (typeof name !== 'string' || !name) {
		problems.push(`tool_calls[${index}] named no tool`);
		return null;
	}
	if (!isObject(args)) {
		problems.push(`tool_calls[${index}] args were not an object`);
		return null;
	}
	return { tool: name, args };
}

/**
 * Reads `tool_calls`. Only a missing or null value means "no calls"; any other
 * is checked like a call, so it cannot vanish. A single call object is wrapped
 * in a list. `dropped` is true when anything the reply described was lost.
 */
function readCalls(raw: unknown, problems: string[]): { calls: ToolCall[]; dropped: boolean } {
	let entries: unknown = raw ?? [];
	if (isObject(entries)) entries = [entries];
	if (!Array.isArray(entries)) {
		problems.push('tool_calls was not a list');
		return { calls: [], dropped: true };
	}
	const calls: ToolCall[] = [];
	entries.forEach((entry, index) => {
		const call = readCall(entry, index, problems);
		if (call) calls.push(call);
	});
	return { calls, dropped: calls.length < entries.length };
}

/** A reply that asked for nothing, with the reason it could not be used. */
function unusable(problem: string): TextReply {
	return { thought: '', toolCalls: [], done: false, answer: '', problems: [problem] };
}

// =============================================================================
// PARSE — the one entry point
// =============================================================================

/**
 * Turns the model's text reply into a TextReply, repairing what is safe and naming each dropped
 * thing in words the model can act on. `done` holds only when the reply asked to finish with a non-
 * blank answer and no call was dropped. @param text - Bare JSON, or JSON in a fence or among prose.
 */
export function parseReply(text: string): TextReply {
	const parsed = extractJson(text);
	if (!parsed.ok) return unusable('the reply was not valid JSON');
	const reply = parsed.value;
	if (!isObject(reply)) return unusable(`the reply was a JSON ${jsonType(reply)}, not an object`);

	const problems: string[] = [];
	const { calls, dropped } = readCalls(reply.tool_calls, problems);
	const answer = asText(reply.answer);

	let done = readDone(reply.done);
	if (done && !answer.trim()) {
		problems.push('it set done=true without an answer');
		done = false;
	}
	if (done && dropped) done = false;
	if (!done && calls.length === 0 && problems.length === 0) {
		problems.push('it had neither done=true nor any tool_calls');
	}

	return { thought: asText(reply.thought), toolCalls: calls, done, answer, problems };
}
