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
// WAVE PLAN — what the model is asked and what it replies
// =============================================================================

import type { ComposedTools } from '../tools';
import { MEMORY_PEEK_TOOL } from './memory';

// =============================================================================
// WAVE TYPES — the shapes the plan, act, check loop passes around
// =============================================================================

/**
 * The Wave loop asks the model for a plan each round, runs the plan's tool
 * calls, and feeds the results back. These are the plain-data shapes that
 * cross those steps; nothing here holds behavior.
 */

// =============================================================================
// PLAN — what the model replies with
// =============================================================================

/** One tool the model wants run. */
export interface ToolCall {
	/** Tool name as the model wrote it. */
	tool: string;
	/** The arguments object the model supplied. */
	args: Record<string, unknown>;
}

/** A parsed model reply: its reasoning, its next tool calls, and whether it thinks it is done. */
export interface PlanReply {
	/** Why the model chose this plan. */
	thought: string;
	/** Notes the model keeps for itself across waves. */
	scratch: string;
	/** Memory keys the model wants dropped. */
	remove: string[];
	/** The tool calls to run this wave, in order. */
	toolCalls: ToolCall[];
	/** Whether the model reports the goal finished. */
	done: boolean;
	/** Whether the model asked to finish (a request the loop may refuse). */
	askedDone: boolean;
	/** The final answer text, when done. */
	answer: string;
	/** Problems found while parsing the reply, to show the model next wave. */
	problems: string[];
}

// =============================================================================
// RESULTS — what a wave records after running a plan
// =============================================================================

/** What one tool call left behind. */
export interface ResultEntry {
	/** Tool name. */
	tool: string;
	/** Stable key for the call, used to spot repeats. */
	key: string;
	/** The arguments the call ran with. */
	args?: unknown;
	/** The tool's result, shortened for the next prompt. */
	summary?: string;
	/** The error message, when the call threw. */
	error?: string;
	/** An extra note for the model, such as a hint for fixing the call. */
	note?: string;
	/** Whether the call repeated an earlier one and was not run again. */
	deduplicated?: boolean;
}

/** Why the loop stopped. */
export type StopReason = 'done' | 'empty_plan' | 'error';

// =============================================================================
// MODEL CALL — the one seam to the language model
// =============================================================================

/** One earlier turn of the conversation. */
export interface HistoryTurn {
	/** Who spoke. */
	role: 'user' | 'assistant';
	/** What was said. */
	content: string;
}

/**
 * One question for the model, split into the parts that cache well.
 * Role and instructions are identical on every call; history only grows at
 * the end; goals and context carry whatever changes per wave.
 */
export interface QuestionSpec {
	/** The model's role line. */
	role: string;
	/** Titled instruction sections, identical on every call. */
	instructions: Array<{ title: string; text: string }>;
	/** Earlier turns, oldest first. */
	history: HistoryTurn[];
	/** What the user wants this run. */
	goals: string[];
	/** Per-wave context: results, memory, check state. */
	context: string[];
	/** The question itself. */
	question: string;
	/** Whether the reply must be JSON. */
	expectJson: boolean;
	/** Whether the host should cache the stable prefix. */
	cachePrefix: boolean;
}

/** Asks the model one question and resolves with its raw text reply. */
export type ModelCall = (q: QuestionSpec) => Promise<string>;

// =============================================================================
// PROMPT TYPES — the pieces of the model's instructions
// =============================================================================

/** The prompt every app shares: a role line and titled sections. */
export interface CorePrompt {
	/** The model's role line. */
	role: string;
	/** Titled instruction sections, in order. */
	sections: Array<{ title: string; text: string }>;
}

/** The prompt text an app adds on top of the core. */
export interface AppPrompts {
	/** Describes the app's workspace layout. */
	workspaceMap: string;
	/** Tells the model which tool or guide to use for which job. */
	router: string;
}

// =============================================================================
// PROMPT ASSEMBLY — the cacheable start and the part that changes each wave
// =============================================================================

/**
 * Each wave asks the model one question. The start of that question (role,
 * instruction sections, history) is the same on every call, so the host can
 * cache it; whatever changes per wave (the request, scratch notes, tool
 * results, loop notes) is appended after it as goals and context. Never edit
 * the start to carry per-wave text: that breaks the cache.
 */

// =============================================================================
// TYPES — the fixed start and the per-wave state
// =============================================================================

/** The part of every question that never changes during a run. */
export interface PromptPrefix {
	/** The model's role line. */
	role: string;
	/** Titled instruction sections, in the order the model reads them. */
	instructions: Array<{ title: string; text: string }>;
}

/** What changes from wave to wave. */
export interface WaveState {
	/** What the user asked for. */
	request: string;
	/** The model's own working notes from earlier waves; empty when it has none. */
	scratch: string;
	/** What the earlier tool calls left behind. */
	results: ResultEntry[];
	/** Messages from the loop to the model, such as why a finish was refused. */
	notes: string[];
}

// =============================================================================
// PREFIX — built once per run
// =============================================================================

/** The question asked on every wave. */
const WAVE_QUESTION = 'Plan the next set of tool calls, or set done=true if the goal is already met.';

/** Writes the tool catalog: one compact JSON line per tool, then memory.peek, which the loop runs itself. */
function toolCatalog(composed: ComposedTools): string {
	return [...composed.tools, MEMORY_PEEK_TOOL].map(({ name, description, parameters }) => JSON.stringify({ name, description, parameters })).join('\n');
}

/**
 * Builds the start of every question for a run. Build it once and reuse it
 * for every wave, so the text is byte-identical each time.
 *
 * @param core - The shared role line and sections; each section becomes one instruction.
 * @param app - The app's workspace map and guide router.
 * @param composed - The mounted tools and their usage instructions.
 * @returns The role and the instructions: core sections, Workspace map, Guides, Available Tools, Tool Instructions.
 */
export function buildPrefix(core: CorePrompt, app: AppPrompts, composed: ComposedTools): PromptPrefix {
	return {
		role: core.role,
		instructions: [...core.sections.map(({ title, text }) => ({ title, text })), { title: 'Workspace map', text: app.workspaceMap }, { title: 'Guides', text: app.router }, { title: 'Available Tools', text: toolCatalog(composed) }, { title: 'Tool Instructions', text: composed.instructions }],
	};
}

// =============================================================================
// WAVE QUESTION — built once per wave
// =============================================================================

/**
 * Builds one wave's question: the fixed start, the history, then this wave's
 * request and context. Context items are always strings, because the client
 * turns any object into "[object Object]".
 *
 * @param prefix - The run's fixed start (see buildPrefix).
 * @param history - Earlier conversation turns, oldest first; it only grows at the end.
 * @param state - This wave's request, scratch notes, results and loop notes.
 * @returns The question, asking for JSON and for the start to be cached.
 */
export function buildWaveQuestion(prefix: PromptPrefix, history: HistoryTurn[], state: WaveState): QuestionSpec {
	const context: string[] = [];
	if (state.scratch) context.push(`Scratch (your working notes from previous steps):\n${state.scratch}`);
	if (state.results.length) context.push(`Previous tool results:\n${JSON.stringify(state.results, null, 2)}`);
	context.push(...state.notes);
	return {
		role: prefix.role,
		instructions: prefix.instructions,
		history: [...history],
		goals: [state.request],
		context,
		question: WAVE_QUESTION,
		expectJson: true,
		cachePrefix: true,
	};
}

// =============================================================================
// REPLY — reading the model's reply and repairing what can be repaired
// =============================================================================

/**
 * Models get the reply format wrong in small, regular ways. parseReply finds
 * the JSON in the model's text and repairs those slips once, so the loop can
 * trust the PlanReply it gets. This is a port of Wave's `normalize_plan`
 * (`nodes/src/nodes/agent_rocketride/planner.py`); the problem strings are
 * worded for the model to act on, so they match it word for word.
 */

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

/** Parses JSON text without throwing. */
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
 * The flat shape: an entry's keys that are not call keys are its arguments,
 * values untouched. Three call keys are real argument names for some tools
 * (`name` of describe_component and show_view; `input` of send_data), so
 * they are arguments where they cannot be anything else:
 * `name` whenever `tool` is given, since it then names nothing, and `input`
 * and `parameters` when `plainText` says they hold plain text.
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
 * Reads one entry of `tool_calls`, taking OpenAI's `{name, arguments}` and
 * `{function: {name, arguments}}` shapes (arguments as JSON text) as
 * `{tool, args}`. Returns null, with a problem recorded, for an entry that
 * cannot be run.
 *
 * This departs from Python Wave, which reads arguments only from `args` and
 * OpenAI's `arguments` and otherwise runs the call with `{}`. Claude writes
 * `{"name": ..., "input": {...}}` (Anthropic's tool_use) and sometimes puts
 * the arguments flat beside `tool`, so a call then ran with nothing and failed
 * in a way the model could not trace. The arguments are taken from the first of
 * `entry.args`, `fn.arguments`, `entry.input`, `fn.input`, `entry.parameters`
 * and `fn.parameters` that is not undefined or null, where `fn` is the
 * `function` object, or the entry itself without one. JSON text in the one
 * taken is parsed. With none of them, the entry's other keys are the
 * arguments (see flatArgs).
 *
 * One exception keeps `input` usable as an argument: when the one taken is the
 * entry's own `input` or `parameters`, it is text that is not a JSON object,
 * and other keys sit beside it, the text is an argument of that name and the
 * entry is read as flat. `{"tool": "send_data", "task_token": ..., "input": "hello"}`
 * is that, not arguments that failed to parse. With nothing beside it, such
 * text is still reported.
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

/**
 * Reads `remove`. A single key is wrapped in a list. A blank key is dropped
 * too: the memory node reads a clear without a key as "clear everything",
 * which would wipe the results this reply's calls store. Problems here are
 * reported but never block a reply, since remove only tidies memory.
 */
function readRemove(raw: unknown, problems: string[]): string[] {
	let entries: unknown = raw ?? [];
	if (typeof entries === 'string') entries = [entries];
	if (!Array.isArray(entries)) {
		problems.push('remove was not a list of keys, so nothing was removed');
		return [];
	}
	const keys: string[] = [];
	entries.forEach((key, index) => {
		if (typeof key === 'string' && key.trim()) keys.push(key);
		else problems.push(`remove[${index}] was not a key, so it was ignored`);
	});
	return keys;
}

/** A reply that asked for nothing, with the reason it could not be used. */
function unusable(problem: string): PlanReply {
	return {
		thought: '',
		scratch: '',
		remove: [],
		toolCalls: [],
		done: false,
		askedDone: false,
		answer: '',
		problems: [problem],
	};
}

// =============================================================================
// PARSE — the one entry point
// =============================================================================

/**
 * Turns the model's text reply into a PlanReply, repairing what can be
 * repaired safely and naming, in words the model can act on, each thing that
 * had to be dropped.
 *
 * `done` is true only when the reply asked to finish with a non-blank answer
 * and none of its calls were dropped, since the work it described did not all
 * happen otherwise. `askedDone` keeps what the model asked for, so the loop
 * can keep the results of a reply whose finish was refused.
 *
 * @param text - The raw reply: bare JSON, or JSON in a fence or among prose.
 * @returns The plan, with `problems` empty when nothing needed fixing.
 */
export function parseReply(text: string): PlanReply {
	const parsed = extractJson(text);
	if (!parsed.ok) return unusable('the reply was not valid JSON');
	const reply = parsed.value;
	if (!isObject(reply)) return unusable(`the reply was a JSON ${jsonType(reply)}, not an object`);

	const problems: string[] = [];
	const askedDone = readDone(reply.done);
	const { calls, dropped } = readCalls(reply.tool_calls, problems);
	const remove = readRemove(reply.remove, problems);
	const answer = asText(reply.answer);

	let done = askedDone;
	if (done && !answer.trim()) {
		problems.push('it set done=true without an answer');
		done = false;
	}
	if (done && dropped) done = false;
	// A bad remove is reported but is never the reason a reply cannot be used,
	// so it must not hide the real one.
	if (!done && calls.length === 0 && problems.every((problem) => problem.startsWith('remove'))) {
		problems.push('it had neither done=true nor any tool_calls');
	}

	return {
		thought: asText(reply.thought),
		scratch: asText(reply.scratch),
		remove,
		toolCalls: calls,
		done,
		askedDone,
		answer,
		problems,
	};
}
