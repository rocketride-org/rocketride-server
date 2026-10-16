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
// DATABASE FOLD SELF-TEST — the log in, the rows the screens read out
// =============================================================================
//
// The same shape as `rules.selftest.ts` and `replayCopy.selftest.ts`: a pure
// function that returns its failures, wired to nothing, because the app is a
// shell bundle rather than a package with a test runner.
//
// It exists because the fold is now the ONLY thing standing between a row in
// `dd_events` and everything the app believes. Capture moved server-side, so
// a decoding bug no longer shows up as "this screen looks odd while I watch
// it" — it shows up as months of history being read wrong, silently, on every
// machine at once. The four cases are the four ways that happens:
//
// 1. an event type decoded wrong (a `reaction` that never reaches its answer);
// 2. a thread scattered across rows (the follow-up, the reaction and the
//    Slack page all have to land on the question that started it);
// 3. a duplicate delivery counted twice (two capture components write the
//    same keys, and a page boundary can re-read a row);
// 4. the stored verdict lost under the replayed events, or a graded row that
//    refuses to reopen when something new happened in its thread.
// =============================================================================

import { rowsFromDatabase, foldEvents, emptyFold } from './fold';
import type { ApprovedQa, EventRow, ThreadState } from './repo';
import { DEFAULT_SETTINGS, type BotSettings } from '../state/types';

// =============================================================================
// FIXTURES
// =============================================================================

/** The thread every case is about: the question's message id IS the thread id. */
const Q = 'msg-question';

/** The bot's answer message, which is what a reader reacts to. */
const A = 'msg-answer';

/** A follow-up the asker posts in the thread. */
const F = 'msg-followup';

/** Settings with a team role, so a team reply is recognised as one. */
const SETTINGS: BotSettings = {
	...DEFAULT_SETTINGS,
	discord: { ...DEFAULT_SETTINGS.discord, teamRoleId: 'role-team' },
};

/** Base metadata every event in the fixture thread carries. */
function metadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		messageId: Q,
		channelId: 'chan-1',
		guildId: 'guild-1',
		authorId: 'user-asker',
		correlationId: 'corr-1',
		botUserId: 'bot-1',
		...extra,
	};
}

/**
 * One `dd_events` row.
 *
 * `payload` is built as the node broadcasts it — `{schemaVersion, eventType,
 * metadata, ...payload}` — because that is the contract `parseDiscordEvent`
 * reads, and a fixture that cheated on the shape would test nothing.
 */
function event(seq: number, eventType: string, payload: Record<string, unknown>, over: Partial<EventRow> = {}): EventRow {
	return {
		seq,
		eventType,
		messageId: ((payload.metadata as Record<string, unknown> | undefined)?.messageId as string) ?? Q,
		eventKey: '',
		threadId: null,
		occurredAt: 1_700_000_000_000 + seq * 1000,
		payload: { schemaVersion: 1, eventType, ...payload },
		source: 'discord:discord_1',
		...over,
	};
}

/** The question. */
function question(seq = 1): EventRow {
	return event(seq, 'message', { metadata: metadata(), lane: 'text', text: 'How do I install it?' });
}

/** The bot's answer, posted as `A`. */
function outbound(seq = 2, text = 'Run npm install rocketride.'): EventRow {
	return event(seq, 'outbound', {
		metadata: metadata({ threadId: Q }),
		messageIds: [A],
		destination: 'thread',
		text,
	});
}

/** A follow-up in the thread, from the asker. */
function followUp(seq = 3): EventRow {
	return event(
		seq,
		'message',
		{
			metadata: metadata({ messageId: F, threadId: Q, authorId: 'user-asker' }),
			lane: 'text',
			text: 'And on Windows?',
		},
		{ messageId: F, threadId: Q }
	);
}

/** A reader's thumbs-up on the bot's ANSWER, not on the question. */
function reaction(seq = 4): EventRow {
	return event(seq, 'reaction', { metadata: metadata({ messageId: A, threadId: Q }), emoji: '✅', added: true, userId: 'user-asker' }, { messageId: A, eventKey: `user-asker:✅:add:${seq}`, threadId: Q });
}

/** An imported `slack_page` row (written before pages were inferred). */
function slackPage(seq = 5): EventRow {
	return {
		seq,
		eventType: 'slack_page',
		messageId: Q,
		eventKey: '',
		threadId: null,
		occurredAt: 1_700_000_000_000 + seq * 1000,
		payload: { schemaVersion: 1, eventType: 'slack_page', metadata: metadata() },
		source: 'tool_slack:tool_slack_1',
	};
}

// =============================================================================
// API
// =============================================================================

/**
 * Run every case.
 *
 * @returns One message per failing assertion; empty when the decoding, the
 *          thread folding, the dedupe and the overlay all still behave.
 */
export function runDbSelfTest(): string[] {
	const failures: string[] = [];

	/** Assert two scalars are equal. */
	const eq = (name: string, actual: unknown, expected: unknown): void => {
		if (actual !== expected) failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`);
	};

	/** Assert a condition holds. */
	const ok = (name: string, condition: boolean): void => {
		if (!condition) failures.push(`${name}: expected to hold, did not`);
	};

	// =========================================================================
	// 1. EVERY EVENT TYPE DECODES
	// =========================================================================

	{
		const rows = rowsFromDatabase([question()], [], SETTINGS);
		eq('message: one row', rows.length, 1);
		eq('message: the row is the question', rows[0]?.id, Q);
		eq('message: the question text is read', rows[0]?.question, 'How do I install it?');
		eq('message: nothing has happened yet', rows[0]?.outcome, 'pending');
		eq('message: the asker is recorded', rows[0]?.authorId, 'user-asker');
	}

	{
		const rows = rowsFromDatabase([question(), outbound()], [], SETTINGS);
		eq('outbound: still one row', rows.length, 1);
		eq('outbound: the answer lands', rows[0]?.answer, 'Run npm install rocketride.');
		eq('outbound: the outcome is answered', rows[0]?.outcome, 'answered');
		ok('outbound: the reply message id is kept', rows[0]?.replyMessageIds?.includes(A) === true);
	}

	{
		const escalated = outbound(2, 'I cannot help with that. Escalated to the RocketRide team.');
		const rows = rowsFromDatabase([question(), escalated], [], SETTINGS);
		eq('outbound: an escalation is recognised', rows[0]?.outcome, 'escalated');
	}

	{
		const silent = event(2, 'no_reply', { metadata: metadata(), reason: 'no_answer' }, { eventKey: 'no_answer' });
		const rows = rowsFromDatabase([question(), silent], [], SETTINGS);
		eq('no_reply: the outcome is no_reply', rows[0]?.outcome, 'no_reply');
		eq('no_reply: the reason is kept', rows[0]?.reason, 'no_answer');
	}

	{
		const rows = rowsFromDatabase([question(), outbound(), reaction()], [], SETTINGS);
		// The reaction names the BOT's message, so it only reaches this row
		// through `replyMessageIds` — which is the whole point of keeping them.
		ok('reaction: the emoji lands on the question row', rows[0]?.reactions.includes('✅') === true);
	}

	{
		const rows = rowsFromDatabase([question(), slackPage(2)], [], SETTINGS);
		eq('slack_page: the row is marked', rows[0]?.pagedSlack, true);
	}

	// =========================================================================
	// 2. ONE THREAD IS ONE ROW
	// =========================================================================

	{
		const rows = rowsFromDatabase([question(1), outbound(2), followUp(3), reaction(4), slackPage(5)], [], SETTINGS);
		eq('thread: five events fold into ONE row', rows.length, 1);
		const row = rows[0];
		eq('thread: the row is the question', row?.id, Q);
		eq('thread: the answer survives the follow-up', row?.answer, 'Run npm install rocketride.');
		ok('thread: the reaction is on it', row?.reactions.includes('✅') === true);
		eq('thread: the Slack page is on it', row?.pagedSlack, true);
		// The log is what the grader reads, and it has to carry the whole thread
		// in order: the question, the bot's answer, the follow-up and the page.
		const types = (row?.events ?? []).map((entry) => entry.type);
		ok(`thread: the question is logged first (${types.join(', ')})`, types[0] === 'question');
		ok('thread: the bot answer is logged', types.includes('ralph_answer'));
		ok('thread: the follow-up is logged', types.includes('user_message'));
		ok('thread: the reaction is logged', types.includes('reaction_add'));
		ok('thread: the Slack page is logged', types.includes('slack_page'));
		const stamps = (row?.events ?? []).map((entry) => entry.ts);
		ok(
			`thread: the log is in order (${stamps.join(', ')})`,
			stamps.every((ts, index) => index === 0 || stamps[index - 1] <= ts)
		);
	}

	{
		// No `slack_page` row: the page is read from the first escalation reply,
		// and only on a pipe whose rows say it pages Slack.
		const paging = { source: 'discord:discord_1+tool_slack' };
		const escalation = { ...outbound(2, 'Sorry about that. Escalated to the RocketRide team.'), ...paging };
		const paged = rowsFromDatabase([{ ...question(1), ...paging }, escalation], [], SETTINGS);
		eq('page: the first escalation on a paging pipe is the page', paged[0]?.pagedSlack, true);
		eq('page: it is logged once', (paged[0]?.events ?? []).filter((entry) => entry.type === 'slack_page').length, 1);

		const again = event(4, 'outbound', { metadata: metadata({ messageId: F, threadId: Q }), messageIds: ['msg-a2'], text: 'Escalated to the RocketRide team.' }, { messageId: F, threadId: Q, ...paging });
		const twice = rowsFromDatabase([{ ...question(1), ...paging }, escalation, { ...followUp(3), ...paging }, again], [], SETTINGS);
		eq('page: a second escalation in the thread is not a second page', (twice[0]?.events ?? []).filter((entry) => entry.type === 'slack_page').length, 1);

		const plain = rowsFromDatabase([question(1), outbound(2, 'Escalated to the RocketRide team.')], [], SETTINGS);
		ok('page: a pipe without Slack never pages', plain[0]?.pagedSlack !== true);

		const answered = rowsFromDatabase(
			[
				{ ...question(1), ...paging },
				{ ...outbound(2), ...paging },
			],
			[],
			SETTINGS
		);
		ok('page: an answer that does not escalate is not a page', answered[0]?.pagedSlack !== true);
	}

	{
		// A team member replying in the thread is what retires an escalation from
		// "Needs you" — and only when it lands AFTER the escalation.
		const escalated = outbound(2, 'Escalated to the RocketRide team.');
		const teamReply = event(
			3,
			'message',
			{
				metadata: metadata({
					messageId: 'msg-team',
					threadId: Q,
					authorId: 'user-team',
					authorRoleIds: ['role-team'],
				}),
				lane: 'text',
				text: 'Looking at it now.',
			},
			{ messageId: 'msg-team', threadId: Q }
		);
		const rows = rowsFromDatabase([question(1), escalated, teamReply], [], SETTINGS);
		eq('thread: the team reply folds into the same row', rows.length, 1);
		eq('thread: the escalation is retired', rows[0]?.teamReplied, true);
	}

	// =========================================================================
	// 3. A DUPLICATE DELIVERY FOLDS ONCE
	// =========================================================================

	{
		// The same `(message_id, event_type, event_key)` twice — two capture
		// components writing, or a page boundary re-reading. The second one must
		// change nothing at all.
		const once = rowsFromDatabase([question(1), reaction(4)], [], SETTINGS);
		const twice = rowsFromDatabase([question(1), reaction(4), { ...reaction(4), seq: 9 }], [], SETTINGS);
		eq('dedupe: still one row', twice.length, once.length);
		eq('dedupe: the emoji is not counted twice', twice[0]?.reactions.length, once[0]?.reactions.length);
		eq('dedupe: the event log did not grow', (twice[0]?.events ?? []).length, (once[0]?.events ?? []).length);
	}

	{
		// The same key arriving on a LATER page is the case the row-level dedupe
		// exists for: `insertEvalEvent` would catch the log entry, but the row
		// patches have no idempotence of their own.
		const first = foldEvents(emptyFold(), [question(1), outbound(2)], SETTINGS);
		const second = foldEvents(first, [{ ...outbound(2), seq: 7 }], SETTINGS);
		eq('dedupe: a re-read page adds no row', second.rows.length, 1);
		eq('dedupe: a re-read page adds no log entry', (second.rows[0]?.events ?? []).length, (first.rows[0]?.events ?? []).length);
		eq('dedupe: the cursor still advances', second.seq, 7);
	}

	// =========================================================================
	// 4. THE STORED THREAD STATE WINS
	// =========================================================================

	const graded: ThreadState = {
		threadId: Q,
		evalStatus: 'graded',
		outcome: 'resolved_unconfirmed',
		outcomeSource: 'auto',
		cause: null,
		causeSource: null,
		excludedReason: null,
		clusterId: 'install-trouble',
		qTopScore: 0.42,
		aTopScore: null,
		graderJson: '{"summary":"answered it","_auto_outcome":"resolved_unconfirmed"}',
		qaDraft: null,
		// After the last event in the fixture thread (seq 2 → …002000).
		gradedAt: 1_700_000_100_000,
		reviewedBy: null,
		reviewedAt: null,
		dismissed: false,
		replay: false,
	};

	{
		const rows = rowsFromDatabase([question(1), outbound(2)], [graded], SETTINGS);
		eq('overlay: the stored status wins', rows[0]?.evalStatus, 'graded');
		eq('overlay: the stored outcome wins', rows[0]?.evalOutcome, 'resolved_unconfirmed');
		eq('overlay: the grade is rebuilt', rows[0]?.grade?.clusterId, 'install-trouble');
		eq('overlay: the retrieval distance survives', rows[0]?.grade?.qTopScore, 0.42);
		ok('overlay: the grader JSON is text the card can parse', typeof rows[0]?.grade?.graderJson === 'string' && JSON.parse(rows[0]?.grade?.graderJson ?? '{}')._auto_outcome === 'resolved_unconfirmed');
	}

	{
		// A new event in the thread after the grade reopens it — the reference's
		// `reopenThread`, which the live capture got from `withEvalEvent` and
		// which the overlay has to state for itself.
		const rows = rowsFromDatabase([question(1), outbound(2), followUp(300)], [graded], SETTINGS);
		eq('overlay: a later event reopens a graded row', rows[0]?.evalStatus, 'open');
	}

	{
		// A REVIEWED row is a human's decision and never reopens.
		const reviewed: ThreadState = {
			...graded,
			evalStatus: 'reviewed',
			outcome: 'resolved_confirmed',
			outcomeSource: 'review',
			reviewedBy: 'ada',
			reviewedAt: 1_700_000_100_000,
		};
		const rows = rowsFromDatabase([question(1), outbound(2), followUp(300)], [reviewed], SETTINGS);
		eq('overlay: a reviewed row stays reviewed', rows[0]?.evalStatus, 'reviewed');
		eq('overlay: the reviewer is named', rows[0]?.reviewedBy, 'ada');
	}

	{
		// The approved pair comes from `dd_qa_pairs`, not from the thread row.
		const pair: ApprovedQa = {
			id: 7,
			threadId: Q,
			question: 'How do I install it?',
			answer: 'npm install rocketride',
			approvedBy: 'ada',
			approvedAt: 1_700_000_200_000,
			ingestedAt: null,
		};
		const rows = rowsFromDatabase([question(1), outbound(2)], [graded], SETTINGS, [pair]);
		eq('overlay: the approved answer lands', rows[0]?.qaApproved?.answer, 'npm install rocketride');
		eq('overlay: an unlanded pair is still pending', rows[0]?.qaApproved?.ingestedAt, null);
	}

	{
		// A thread row for a conversation this window does not hold must not
		// invent one.
		const orphan: ThreadState = { ...graded, threadId: 'msg-elsewhere' };
		const rows = rowsFromDatabase([question(1)], [orphan], SETTINGS);
		eq('overlay: an orphan thread row adds nothing', rows.length, 1);
		eq('overlay: the real row is untouched', rows[0]?.evalStatus, 'open');
	}

	return failures;
}
