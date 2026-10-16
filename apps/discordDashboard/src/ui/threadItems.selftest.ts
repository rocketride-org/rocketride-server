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
// threadItems self-test — the drawer's thread, from a row's own data
// =============================================================================

import type { ConversationRow } from '../state/types';
import { EMPTY_EVAL_FIELDS, EVENT_TEXT_LIMIT } from '../eval/events';
import { threadItems } from './threadItems';

/** A row with just enough on it. */
function row(over: Partial<ConversationRow> = {}): ConversationRow {
	return {
		...EMPTY_EVAL_FIELDS,
		id: 'q',
		seenAt: 1000,
		channelId: 'c',
		guildId: 'g',
		threadId: 'q',
		authorId: 'user-1',
		authorName: null,
		correlationId: null,
		question: 'How do I install it?',
		answer: 'Run `npm install rocketride`.',
		outcome: 'answered',
		reason: null,
		attachments: [],
		reactions: [],
		updatedAt: 5000,
		...over,
	} as ConversationRow;
}

/**
 * Run every case.
 *
 * @returns One message per failing assertion.
 */
export function runThreadSelfTest(): string[] {
	const failures: string[] = [];
	const eq = (name: string, actual: unknown, expected: unknown): void => {
		if (actual !== expected) failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`);
	};

	{
		const items = threadItems(
			row({
				pagedSlack: true,
				retries: 1,
				events: [
					{ type: 'reaction_add', ts: 5, actor_id: 'user-1', message_id: 'a2', data: { emoji: '✅' } },
					{ type: 'question', ts: 1, actor_id: 'user-1', message_id: 'q', text: 'How do I install it?' },
					{ type: 'ralph_answer', ts: 2, actor_id: 'bot', message_id: 'a1', text: 'Run it.' },
					{ type: 'user_message', ts: 3, actor_id: 'user-1', message_id: 'f', text: 'And on Windows?' },
					{ type: 'escalation', ts: 4, actor_id: 'bot', message_id: 'a2', text: 'Escalated to the RocketRide team.' },
					{ type: 'slack_page', ts: 4, actor_id: null, message_id: null },
				],
			})
		);
		const shape = items.map((item) => (item.kind === 'bubble' ? item.side : item.note)).join(',');
		eq('thread: in time order', shape, 'person,ralph,person,ralph,slack,reaction');
		const first = items[1];
		eq('thread: the first answer carries retried', first.kind === 'bubble' && first.notes.includes('retried'), true);
		const escalation = items[3];
		eq('thread: the escalation says so', escalation.kind === 'bubble' && escalation.notes.includes('escalated'), true);
		const followUp = items[2];
		eq('thread: a follow-up is marked', followUp.kind === 'bubble' && followUp.notes.includes('follow-up'), true);
	}

	{
		const items = threadItems(row());
		eq('fallback: an old row is question then answer', items.map((item) => item.kind === 'bubble' && item.side).join(','), 'person,ralph');
	}

	{
		const long = 'x'.repeat(EVENT_TEXT_LIMIT + 50);
		const items = threadItems(
			row({
				answer: long,
				events: [
					{ type: 'question', ts: 1, actor_id: 'user-1', message_id: 'q', text: 'How do I install it?' },
					{ type: 'ralph_answer', ts: 2, actor_id: 'bot', message_id: 'a1', text: long.slice(0, EVENT_TEXT_LIMIT) },
				],
			})
		);
		const answer = items[1];
		eq('clip: a clipped answer shows the whole one', answer.kind === 'bubble' ? answer.text.length : 0, long.length);
	}

	{
		const items = threadItems(row({ events: [{ type: 'ralph_answer', ts: 2, actor_id: 'bot', message_id: 'a1', text: 'Run it.' }] }));
		eq('gap: a log without the question still opens with it', items[0]?.kind === 'bubble' && items[0].side, 'person');
	}

	{
		const items = threadItems(row({ answer: null, outcome: 'no_reply', reason: 'non_answer' }));
		eq(
			'no reply: an old row shows why',
			items.some((item) => item.kind === 'note' && item.note === 'no_reply'),
			true
		);
	}

	return failures;
}
