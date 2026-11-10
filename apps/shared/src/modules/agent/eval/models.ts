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
// MODELS: what answers the stand-in pipeline's chat in L1 and L2
// =============================================================================

/**
 * The agent asks its model through the stand-in pipeline's `chat`. On the
 * fake engine that chat comes here:
 *
 * - L1, `ReplayModel`: the recorded replies of a live trial, in order. A
 *   plan question takes the next recorded plan reply; a best-effort question
 *   takes the recorded best-effort answer. A
 *   question the recording has nothing for ends the turn and marks the replay
 *   as diverged, which scores as an error, never as a pass.
 * - L2, `liveModel`: Anthropic's Messages API or OpenAI's Responses API,
 *   called with fetch. It does what the engine's model node does with a question: renders
 *   it with the Python client's Question.getPrompt, marks the unchanging start
 *   for prompt caching, and, for a question that expects JSON, parses the
 *   reply and asks again up to three times the way ChatBase.chat does
 *   (packages/ai/src/ai/common/chat.py). The JSON parse is a strict subset of
 *   the engine's parseJson: one value, optionally fenced, then at most a
 *   closing fence and a remark.
 *
 * Keys come from the environment (the runner puts them there from the
 * caller's environment or tokenstash). They are read here and sent in the
 * request's headers, never printed.
 */

import type { ModelAnswer, ModelQuestion } from './engine';

// =============================================================================
// THE ENGINE'S PROMPT: packages/client-python/src/rocketride/schema/question.py getPrompt
// =============================================================================

const CRLF = '\r\n';

interface Instruction {
	subtitle: string;
	instructions: string;
}

/** Python's textwrap.dedent: removes the indentation every non-blank line shares. */
function dedent(text: string): string {
	const lines = text.split('\n');
	const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)?.[0] ?? '');
	if (!indents.length) return text;
	let common = indents[0];
	for (const ind of indents) while (!ind.startsWith(common)) common = common.slice(0, -1);
	return lines.map((l) => (l.startsWith(common) ? l.slice(common.length) : l.trim() ? l : '')).join('\n');
}

/**
 * Renders a question the way the engine does before it calls the provider.
 *
 * @param q - The client's Question, as an object.
 * @param jsonFailed - Whether to add the engine's note that the last reply was not valid JSON.
 * @returns The prompt text.
 */
export function enginePrompt(q: ModelQuestion, jsonFailed = false): string {
	const parts: string[] = [];
	if (q.role) parts.push(`${String(q.role)}${CRLF}`);
	const all: Instruction[] = [];
	if (q.expectJson) {
		all.push({
			subtitle: 'JSON Response Format',
			instructions: '- Respond **only** with a fenced, valid JSON structure.\r\n' + '- Properly escape all quotes within content strings.\r\n' + '- No additional text, comments, or explanations.\r\n' + '- Ensure your answer is strictly valid JSON format.\r\n' + '- Double check the JSON response to ensure it is valid.\r\n' + '- Enclose the json with ```json and ``` tags.',
		});
		if (jsonFailed) all.push({ subtitle: 'CRITICAL', instructions: '- Your previous response returned invalid JSON.\r\n- Examine your JSON and ensure it is complete and follows the JSON standards.' });
	}
	all.push(...((q.instructions as Instruction[]) ?? []));
	if (all.length) {
		const lines = ['### System Instructions:'];
		all.forEach((inst, i) => {
			lines.push(`    ${i + 1}) **${inst.subtitle.trim()}**:`);
			const text = inst.instructions.split(/\r\n|\r|\n/).join('\n');
			for (const line of dedent(text).split('\n')) if (line.trim()) lines.push(`        ${line.trimEnd()}`);
			lines.push('');
		});
		parts.push(lines.join(CRLF));
	}
	const examples = (q.examples as Array<{ given: string; result: string }>) ?? [];
	if (examples.length) {
		const begin = q.expectJson ? `\`\`\`json${CRLF}` : '';
		const end = q.expectJson ? `${CRLF}\`\`\`` : '';
		const lines = ['### Examples:'];
		examples.forEach((ex, i) => {
			lines.push(`    Example ${i + 1}`, `        **Given**: ${ex.given.trim()}`, `        **Expected output**: ${begin}${ex.result.trim()}${end}`);
		});
		lines.push('');
		parts.push(lines.join(CRLF));
	}
	const history = (q.history as Array<{ role: string; content: string }>) ?? [];
	if (history.length) parts.push(['### Conversation History:', ...history.map((h) => `    ${h.role}: ${h.content}`), ''].join(CRLF));
	const context = (q.context as string[]) ?? [];
	if (context.length) {
		const lines = ['### Context:'];
		context.forEach((c, i) => lines.push(`    ${i + 1}) ${String(c).trim()}`, ''));
		lines.push('');
		parts.push(lines.join(CRLF));
	}
	const goals = (q.goals as string[]) ?? [];
	if (goals.length) parts.push(['### Ultimate Goal:', ...goals.map((g, i) => `    ${i + 1}) ${g.trim()}`), ''].join(CRLF));
	const questions = (q.questions as Array<{ text: string }>) ?? [];
	if (questions.length) parts.push(['### Current Task:', ...questions.map((x) => `    ${x.text}`), ''].join(CRLF));
	parts.push('');
	return parts.join(CRLF);
}

/**
 * The start of the prompt that stays the same between waves, as the engine
 * marks it for caching: the prompt with no context, goals or questions.
 *
 * @param q - The question.
 * @returns The prefix, or '' when the question does not ask for caching.
 */
export function cachePrefix(q: ModelQuestion): string {
	if (!q.cachePrefix) return '';
	return enginePrompt({ ...q, context: [], documents: [], goals: [], questions: [] });
}

// =============================================================================
// THE ENGINE'S JSON CHECK: a strict subset of packages/ai/src/ai/common/util.py parseJson
// =============================================================================

/**
 * Reads one JSON value from a reply, as the engine's check accepts it.
 *
 * @param reply - The model's text.
 * @returns The value.
 * @throws With the reason, as the engine's parse error reads ("Extra data", "Expecting value").
 */
export function engineJson(reply: string): unknown {
	let text = reply
		.trim()
		.replace(/<think>[\s\S]*?<\/think>/g, '')
		.trim();
	let fenced = false;
	const fence = /^```(?:json)?\s*/i.exec(text) ?? /```json\s*/i.exec(text);
	if (fence) {
		const before = text.slice(0, fence.index);
		if (before.includes('```') || /[{[]/.test(before)) throw new Error('Expecting value: line 1 column 1 (char 0)');
		text = text.slice(fence.index + fence[0].length);
		fenced = true;
	}
	const end = valueEnd(text);
	if (end < 0) throw new Error('Expecting value: line 1 column 1 (char 0)');
	const value = JSON.parse(text.slice(0, end)) as unknown;
	let rest = text.slice(end).trim();
	if (fenced && rest.startsWith('```')) rest = rest.slice(3).trim();
	if (rest && (rest.includes('```') || /[{}[\]]/.test(rest) || /^[,:"]/.test(rest))) throw new Error(`Extra data: line 1 column ${end + 1} (char ${end})`);
	return value;
}

/** Where the first JSON object or array in a text ends, or -1. */
function valueEnd(text: string): number {
	const start = text.search(/[{[]/);
	if (start !== 0) return -1;
	let depth = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === '{' || c === '[') depth++;
		else if (c === '}' || c === ']') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

// =============================================================================
// L1: REPLAY
// =============================================================================

/** One recorded model reply, in the order the trial asked. */
export type RecordedEvent = { wave: number; reply: string } | { bestEffort: string };

/** One recorded turn: its request and the replies it got. */
export interface RecordedTurn {
	request: string;
	events: RecordedEvent[];
}

/** Plays a recording back, one turn at a time. */
export class ReplayModel {
	private turn = -1;
	private at = 0;
	/** Replies handed out, over the whole trial. */
	consumed = 0;
	/** Why the replay left its recording, or null. */
	diverged: string | null = null;

	constructor(private readonly turns: RecordedTurn[]) {}

	/** Replies in the recording, over the whole trial. */
	get recorded(): number {
		return this.turns.reduce((n, t) => n + t.events.length, 0);
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

	/** Replies of the current turn not yet handed out. */
	left(): number {
		return (this.turns[this.turn]?.events.length ?? 0) - this.at;
	}

	/**
	 * Answers one question from the recording.
	 *
	 * @param q - The question.
	 * @returns The recorded reply, or one that ends the turn when the recording has none.
	 */
	answer = async (q: ModelQuestion): Promise<ModelAnswer> => {
		// the plan question is the one that marks its start for caching. Since #2835 it no longer
		// asks for JSON (parseReply reads the text), so expectJson cannot tell it from the best effort
		const plan = q.cachePrefix === true;
		const event = this.turns[this.turn]?.events[this.at];
		const fits = event && (plan ? 'reply' in event : 'bestEffort' in event);
		if (!event || !fits) {
			const want = plan ? 'a plan reply' : 'a best-effort answer';
			this.diverged ??= `turn ${this.turn + 1}: the loop asked for ${want} at reply ${this.at + 1}, and the recording has ${event ? Object.keys(event).filter((k) => k !== 'wave')[0] : 'nothing'} there`;
			return { text: plan ? JSON.stringify({ done: true, answer: 'The replay has no recorded reply here.' }) : 'The replay has no recorded reply here.' };
		}
		this.at++;
		this.consumed++;
		return { text: 'reply' in event ? event.reply : event.bestEffort };
	};
}

// =============================================================================
// L2: LIVE MODELS
// =============================================================================

/** A live model's identity and settings. */
export interface LiveModelSpec {
	provider: 'anthropic' | 'openai';
	model: string;
	maxTokens: number;
}

/** List prices in USD per million tokens: input, output, cache write, cache read. Models not listed get no cost. */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
	'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
	'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
	'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

/**
 * The cost of some tokens at list price.
 *
 * @param model - The model id.
 * @param t - The token counts.
 * @returns USD, or null for a model with no price here.
 */
export function costOf(model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
	const p = PRICES[model];
	if (!p) return null;
	return (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1e6;
}

/** The engine's LLM error answer, which createChatModel turns into a provider error. */
function llmError(err: unknown): string {
	const name = err instanceof Error ? err.constructor.name : 'Error';
	return `**LLM error** — ${name}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * A live model behind the fake engine's stand-in pipeline.
 *
 * @param spec - The provider, model and output limit.
 * @returns The model call the fake engine's chat uses.
 * @throws When the provider's key is not in the environment.
 */
export function liveModel(spec: LiveModelSpec): (q: ModelQuestion) => Promise<ModelAnswer> {
	const ask = spec.provider === 'anthropic' ? anthropicCall(spec) : openaiCall(spec);
	return async (q) => {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const add = (u: typeof usage) => {
			usage.input += u.input;
			usage.output += u.output;
			usage.cacheRead += u.cacheRead;
			usage.cacheWrite += u.cacheWrite;
		};
		let reply: { text: string; usage: typeof usage };
		try {
			reply = await ask(enginePrompt(q), cachePrefix(q));
		} catch (err) {
			return { text: llmError(err), usage };
		}
		add(reply.usage);
		if (!q.expectJson) return { text: reply.text, usage };
		// step: the engine's JSON check, three tries in all
		for (let attempt = 1; ; attempt++) {
			try {
				return { text: JSON.stringify(engineJson(reply.text)), usage };
			} catch (err) {
				if (attempt >= 3) return { text: `**LLM error** — ValueError: Failed to get valid JSON response after 3 attempts. Cause: ${err instanceof Error ? err.message : String(err)}. Last response: ${reply.text.slice(0, 200)}...`, usage };
			}
			try {
				reply = await ask(enginePrompt(q, true), '');
			} catch (err) {
				return { text: llmError(err), usage };
			}
			add(reply.usage);
		}
	};
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ProviderCall = (prompt: string, prefix: string) => Promise<{ text: string; usage: Usage }>;

/**
 * POSTs JSON to a provider, retrying a rate limit, a 5xx or a dropped
 * connection up to four times, as the providers' SDKs do by default.
 */
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
	for (let attempt = 0; ; attempt++) {
		let status = 0;
		let text = '';
		let wait = 2 ** attempt;
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
			status = res.status;
			text = await res.text();
			if (res.ok) return JSON.parse(text) as Record<string, unknown>;
			wait = Number(res.headers.get('retry-after')) || wait;
		} catch (err) {
			text = err instanceof Error ? err.message : String(err);
		}
		if ((status && status !== 429 && status < 500) || attempt >= 4) {
			const message = (() => {
				try {
					return String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text);
				} catch {
					return text;
				}
			})();
			throw new Error(`${status || 'fetch failed'} ${message.slice(0, 300)}`);
		}
		await new Promise((r) => setTimeout(r, wait * 1000));
	}
}

/** Anthropic's Messages API, with the stable start of the prompt marked for caching. */
function anthropicCall(spec: LiveModelSpec): ProviderCall {
	const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ROCKETRIDE_ANTHROPIC_KEY;
	if (!apiKey) throw new Error('L2 with Anthropic needs ANTHROPIC_API_KEY or ROCKETRIDE_ANTHROPIC_KEY in the environment (the runner gets it from tokenstash when it is installed).');
	return async (prompt, prefix) => {
		const content =
			prefix && prompt.startsWith(prefix)
				? [
						{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } },
						{ type: 'text', text: prompt.slice(prefix.length) || ' ' },
					]
				: [{ type: 'text', text: prompt }];
		const message = (await post('https://api.anthropic.com/v1/messages', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, { model: spec.model, max_tokens: spec.maxTokens, messages: [{ role: 'user', content }] })) as {
			content?: Array<{ type: string; text?: string }>;
			usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
		};
		const u = message.usage ?? {};
		return {
			text: (message.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join(''),
			usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
		};
	};
}

/** OpenAI's Responses API, as one user input. */
function openaiCall(spec: LiveModelSpec): ProviderCall {
	const apiKey = process.env.OPENAI_API_KEY || process.env.ROCKETRIDE_OPENAI_KEY;
	if (!apiKey) throw new Error('L2 with OpenAI needs OPENAI_API_KEY or ROCKETRIDE_OPENAI_KEY in the environment (the runner gets it from tokenstash when it is installed).');
	return async (prompt) => {
		const response = (await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${apiKey}` }, { model: spec.model, input: prompt, max_output_tokens: spec.maxTokens })) as {
			output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
			usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
		};
		const text = (response.output ?? [])
			.filter((o) => o.type === 'message')
			.flatMap((o) => o.content ?? [])
			.map((c) => (c.type === 'output_text' ? (c.text ?? '') : ''))
			.join('');
		const u = response.usage ?? {};
		const cached = u.input_tokens_details?.cached_tokens ?? 0;
		return { text, usage: { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 } };
	};
}
