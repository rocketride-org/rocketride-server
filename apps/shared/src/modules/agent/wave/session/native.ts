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
// NATIVE CONVERSATION — the turn as provider messages, tools and call ids
// =============================================================================

/**
 * The adapter for nodes with native tool calling. The conversation is the client's turn-mode
 * `Message[]`: earlier turns as text, the request, then each assistant message exactly as the
 * engine returned it (the provider needs its reasoning back unchanged) and the user message that
 * answers it. The tools go as tool definitions, not in the instructions. A provider needs every
 * tool call answered in the next user message, so this file answers the calls the loop never sees:
 * arguments that were not JSON, and every call in a reply cut at the output limit, which may be cut
 * short and so never runs.
 */

import type { AssistantMessage, Message, TextBlock, Tool, ToolCallBlock, ToolResultBlock } from 'rocketride';

import type { ModelResponse } from '../../model';
import { NATIVE_RESPONSE_FORMAT } from '../../prompts';
import type { HistoryTurn, ResultEntry, ToolSpec } from '../plan';
import type { CallId, Conversation, Opening, Outgoing, PlannedCall, Reading, Round } from './index';

/** The note that asks for the final answer when the run stops unfinished. */
const CONCLUDE_NOTE = 'Based on the above, provide a complete and accurate final answer now, without calling tools. The work stopped before it was finished: if something the goal needs is still unknown, say what is missing rather than guessing.';

/** The note after an answer cut at the output limit. */
const CONTINUE_NOTE = 'Your reply hit the output limit. Continue from exactly where it stopped.';

/** The result of each call in a reply cut at the output limit. */
const CUT_CALL = 'Not run: your reply hit the output limit, so this call may be cut short. You can make it again in smaller parts.';

/** The result of a call whose arguments were not JSON. */
const BAD_ARGS = 'Not run: its arguments were not valid JSON.';

/** Opens the native conversation. */
export function nativeConversation(o: Opening): Conversation {
	return new NativeConversation(o);
}

/** A call of the last reply until the next user message answers it: the loop's to run, or answered here with `own`. */
type Pending = { readonly id: CallId; readonly own?: string };

class NativeConversation implements Conversation {
	readonly adapter = 'native' as const;
	private readonly messages: Message[];
	private readonly system: Extract<Outgoing['request'], { kind: 'turn' }>['system'];
	private readonly tools: readonly Tool[];
	private pending: Pending[] = [];
	private concluding = false;
	/** The characters sent up to the end of the last request, which the provider can read from its cache on the next. */
	private sentChars = 0;

	constructor(o: Opening) {
		this.messages = openingMessages(o.history, o.request);
		this.system = { role: o.prefix.role, instructions: [...o.prefix.instructions, { title: 'Response Format', text: NATIVE_RESPONSE_FORMAT }] };
		this.tools = o.prefix.tools.map(toTool);
	}

	answer(round: Round): void {
		const byId = new Map(round.results.map((result) => [result.id, result.entry]));
		if (byId.size !== round.results.length) throw new Error('A call was answered twice.');
		const results = this.pending.map((call): ToolResultBlock => {
			if (call.own !== undefined) return { type: 'tool_result', callId: call.id, content: call.own, isError: true };
			const entry = byId.get(call.id);
			if (!entry) throw new Error(`Call ${call.id} was left unanswered.`);
			byId.delete(call.id);
			return { type: 'tool_result', callId: call.id, content: contentOf(entry), isError: entry.error !== undefined };
		});
		if (byId.size) throw new Error(`The last reply made no call ${[...byId.keys()].join(', ')}.`);
		this.pending = [];
		this.addUser([...results, ...textBlocks(round.notes)]);
	}

	retry(problems: readonly string[]): void {
		this.answer({ results: [], notes: [`Your previous reply was not usable: ${problems.join('; ')}. Call a tool, or reply with your answer and no tool calls.`] });
	}

	resume(): void {
		this.answer({ results: [], notes: [CONTINUE_NOTE] });
	}

	conclude(): void {
		this.concluding = true;
		this.answer({ results: [], notes: [CONCLUDE_NOTE] });
	}

	request(): Outgoing {
		// step: the tools stay on a conclusion, because a provider refuses tool calls in messages without their definitions
		const request = { kind: 'turn', system: this.system, messages: [...this.messages], tools: this.tools } as const;
		const chars = JSON.stringify(request).length;
		const size = { cachedChars: Math.min(this.sentChars, chars), freshChars: Math.max(0, chars - this.sentChars), cacheable: true };
		this.sentChars = chars;
		return { request, size };
	}

	take(response: ModelResponse): Reading {
		if (response.kind !== 'turn') throw new Error(`A native conversation got a ${response.kind} answer.`);
		const { message, stop } = response;
		const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
		const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
		const calls = blocks.filter((block): block is ToolCallBlock => block.type === 'tool_call');
		const cut = stop === 'max_tokens';
		// step: a conclusion with calls is left out, so nothing is left to answer
		if (this.concluding && calls.length) return { kind: 'unusable', thought: '', problems: ['it called tools'], cut: false };
		this.append(message);
		if (!calls.length) {
			// a blank reply at the output limit is not continued: an overflowing context also stops there, and would again
			if (text.trim()) return { kind: 'answer', thought: '', answer: text, cut };
			return { kind: 'unusable', thought: '', problems: ['it had neither tool calls nor an answer'], cut: false };
		}
		if (cut) {
			this.pending = calls.map((call) => ({ id: call.id as CallId, own: CUT_CALL }));
			return { kind: 'unusable', thought: text, problems: ['it hit the output limit inside a tool call'], cut: true };
		}
		const planned: PlannedCall[] = [];
		const problems: string[] = [];
		this.pending = calls.map((call): Pending => {
			const id = call.id as CallId;
			if (typeof call.args === 'string') {
				problems.push(`${call.name} arguments were not valid JSON`);
				return { id, own: BAD_ARGS };
			}
			planned.push({ id, tool: call.name, args: call.args });
			return { id };
		});
		const [first, ...rest] = planned;
		return first ? { kind: 'calls', thought: text, calls: [first, ...rest] } : { kind: 'unusable', thought: text, problems, cut: false };
	}

	/** Adds the model's message as the engine returned it, unless it holds nothing a provider would take back. */
	private append(message: AssistantMessage): void {
		const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
		if (content.some((block) => block.type !== 'text' || block.text.trim())) this.messages.push(message);
	}

	/** Adds blocks to the user's side: merged into a trailing user message, which is replaced, not changed, since an earlier request holds it. */
	private addUser(blocks: Array<TextBlock | ToolResultBlock>): void {
		if (!blocks.length) return;
		const last = this.messages.at(-1);
		if (last?.role !== 'user') {
			this.messages.push({ role: 'user', content: blocks });
			return;
		}
		const earlier = typeof last.content === 'string' ? textBlocks([last.content]) : last.content;
		this.messages[this.messages.length - 1] = { role: 'user', content: [...earlier, ...blocks] };
	}
}

/**
 * Earlier turns, then the request, as alternating messages that start with the user's: a turn of the
 * same role as the one before merges into it, and a leading answer is dropped.
 */
function openingMessages(history: readonly HistoryTurn[], request: string): Message[] {
	const turns: HistoryTurn[] = [];
	for (const turn of [...history, { role: 'user' as const, content: request }]) {
		if (!turn.content.trim()) continue;
		const last = turns.at(-1);
		if (last?.role === turn.role) last.content = `${last.content}\n\n${turn.content}`;
		else if (last || turn.role === 'user') turns.push({ ...turn });
	}
	return turns;
}

/** Notes as text blocks; a blank one is left out, since providers refuse empty text. */
function textBlocks(notes: readonly string[]): TextBlock[] {
	return notes.filter((note) => note.trim()).map((text) => ({ type: 'text', text }));
}

/** A tool as the engine takes it; the engine maps dotted names (memory.peek) for the provider and back. */
function toTool(spec: ToolSpec): Tool {
	return { name: spec.name, description: spec.description, inputSchema: spec.parameters };
}

/** What the model reads for one call: its entry without the tool and arguments, which its own call already names. */
function contentOf(entry: ResultEntry): string {
	return JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([field]) => field !== 'tool' && field !== 'args')), null, 2);
}
