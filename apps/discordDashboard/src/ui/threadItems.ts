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
// THE THREAD — a conversation row as the things that happened, in order
// =============================================================================
//
// The Conversations drawer used to show a row as a field list, with the
// thread itself only in a one-line-per-event log. This turns the SAME data
// the row already carries — `question`, `answer`, `events`, `retries` — into
// the thread a person reads: the question, Ralph's answers, follow-ups,
// team replies, reactions, the Slack page and any no-reply, oldest first.
// Nothing new is read or stored.
//
// Pure, so `threadItems.selftest.ts` can run it in Node; `Thread.tsx` renders it.
// =============================================================================

import type { ConversationRow } from '../state/types';
import type { EvalEvent } from '../eval/rules';
import { EVENT_TEXT_LIMIT } from '../eval/events';

/** Who a bubble belongs to. */
export type ThreadSide = 'person' | 'ralph' | 'team';

/** One thing in the thread. */
export type ThreadItem =
	| {
			kind: 'bubble';
			key: string;
			side: ThreadSide;
			/** The author's id, for the label (`user …2363`). Null for Ralph. */
			authorId: string | null;
			/** The message text, markdown for Ralph. */
			text: string;
			ts: number;
			/** `follow-up`, `escalated`, `retried` — small words for the meta line. */
			notes: string[];
			/** The Discord message (a reply's first chunk), so reactions can sit under it. */
			messageId?: string | null;
			/** Every chunk id of a reply, which a reaction may be on. */
			replyIds?: string[];
	  }
	| {
			kind: 'note';
			key: string;
			/** What the line is about. */
			note: 'reaction' | 'slack' | 'no_reply';
			ts: number;
			/** The reacting user, for a reaction. */
			actorId: string | null;
			/** The emoji, for a reaction. */
			emoji: string | null;
			/** True when a reaction was removed rather than added. */
			removed: boolean;
			/** The node's reason string, for a no-reply. */
			reason: string | null;
			/** The message a reaction was put on. */
			targetId?: string | null;
	  };

/** The eval event types that are one of Ralph's replies. */
const RALPH_TYPES = new Set(['ralph_answer', 'escalation', 'manipulation_flag', 'dead_end']);

/** The eval event types that are a person writing in the thread. */
const PERSON_TYPES = new Set(['question', 'user_message']);

/** The eval event types that are the team writing in the thread. */
const TEAM_TYPES = new Set(['team_reply', 'team_mention']);

/**
 * The full text for an event whose stored text may have been clipped.
 *
 * The event log keeps at most {@link EVENT_TEXT_LIMIT} characters per
 * message; the row keeps the whole question and the latest whole answer. When
 * a clipped event is the start of one of those, the whole one is shown.
 *
 * @param text - The event's own text.
 * @param full - The row's whole question or answer, when there is one.
 * @returns The text to show.
 */
function fullText(text: string, full: string | null): string {
	if (full !== null && text.length >= EVENT_TEXT_LIMIT && full.startsWith(text)) return full;
	return text;
}

/**
 * The thread for one row, oldest first.
 *
 * @param row - The conversation row.
 * @returns The items, never empty when the row has a question or an answer.
 */
export function threadItems(row: ConversationRow): ThreadItem[] {
	const events: EvalEvent[] = (row.events ?? []).slice().sort((a, b) => a.ts - b.ts);
	const items: ThreadItem[] = [];
	let answers = 0;

	events.forEach((event, index) => {
		const key = `${event.type}-${event.message_id ?? ''}-${index}`;
		const text = event.text ?? '';
		if (PERSON_TYPES.has(event.type)) {
			items.push({
				kind: 'bubble',
				key,
				side: 'person',
				authorId: event.actor_id ?? null,
				text: event.type === 'question' ? fullText(text, row.question || null) : text,
				ts: event.ts,
				notes: event.type === 'user_message' ? ['follow-up'] : [],
				messageId: event.message_id ?? null,
			});
		} else if (TEAM_TYPES.has(event.type)) {
			items.push({ kind: 'bubble', key, side: 'team', authorId: event.actor_id ?? null, text, ts: event.ts, notes: [], messageId: event.message_id ?? null });
		} else if (RALPH_TYPES.has(event.type)) {
			const notes: string[] = [];
			if (event.type === 'escalation') notes.push('escalated');
			if (event.type === 'manipulation_flag') notes.push('manipulation flagged');
			if (event.type === 'dead_end') notes.push('dead end');
			// `retries` counts the node re-asking the FIRST text pass, so it belongs
			// to the first answer; later answers were not retried as far as the row knows.
			if (answers === 0 && (row.retries ?? 0) > 0) notes.push('retried');
			answers += 1;
			items.push({
				kind: 'bubble',
				key,
				side: 'ralph',
				authorId: null,
				text: fullText(text, row.answer),
				ts: event.ts,
				notes,
				messageId: event.message_id ?? null,
				replyIds: Array.isArray(event.data?.message_ids) ? (event.data?.message_ids as string[]) : undefined,
			});
		} else if (event.type === 'reaction_add' || event.type === 'reaction_remove') {
			items.push({
				kind: 'note',
				key,
				note: 'reaction',
				ts: event.ts,
				actorId: event.actor_id ?? null,
				emoji: event.data?.emoji ?? null,
				removed: event.type === 'reaction_remove',
				reason: null,
				targetId: event.message_id ?? null,
			});
		} else if (event.type === 'slack_page') {
			items.push({ kind: 'note', key, note: 'slack', ts: event.ts, actorId: null, emoji: null, removed: false, reason: null });
		} else if (event.type === 'no_reply') {
			const reason = event.data?.reason;
			items.push({
				kind: 'note',
				key,
				note: 'no_reply',
				ts: event.ts,
				actorId: null,
				emoji: null,
				removed: false,
				reason: typeof reason === 'string' ? reason : null,
			});
		}
	});

	// A log that starts mid-thread (an outcome event folded before its
	// question) still shows the row's own question first, and its answer.
	if (items.length > 0) {
		const has = (side: ThreadSide): boolean => items.some((item) => item.kind === 'bubble' && item.side === side);
		if (!items.some((item) => item.kind === 'bubble' && item.side === 'person' && item.notes.length === 0) && row.question) {
			items.unshift({ kind: 'bubble', key: 'question', side: 'person', authorId: row.authorId, text: row.question, ts: row.seenAt, notes: [] });
		}
		if (!has('ralph') && row.answer) {
			items.push({ kind: 'bubble', key: 'answer', side: 'ralph', authorId: null, text: row.answer, ts: row.updatedAt, notes: [] });
		}
	}

	// An old row, captured before the event log existed: its question and its
	// answer are all there is, and they are still a thread.
	if (items.length === 0) {
		if (row.question) {
			items.push({ kind: 'bubble', key: 'question', side: 'person', authorId: row.authorId, text: row.question, ts: row.seenAt, notes: [] });
		}
		if (row.answer) {
			items.push({
				kind: 'bubble',
				key: 'answer',
				side: 'ralph',
				authorId: null,
				text: row.answer,
				ts: row.updatedAt,
				notes: (row.retries ?? 0) > 0 ? ['retried'] : [],
			});
		}
		if (row.pagedSlack === true) {
			items.push({ kind: 'note', key: 'slack', note: 'slack', ts: row.updatedAt, actorId: null, emoji: null, removed: false, reason: null });
		}
		if (row.answer === null && row.reason) {
			items.push({ kind: 'note', key: 'no_reply', note: 'no_reply', ts: row.updatedAt, actorId: null, emoji: null, removed: false, reason: row.reason });
		}
	}
	return items;
}
