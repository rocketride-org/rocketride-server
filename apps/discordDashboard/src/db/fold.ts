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
// THE FOLD — `dd_events` rows in, conversation rows out
// =============================================================================
//
// The rules are the ones the browser-side capture used, moved here unchanged
// and made pure: `applyDiscordEvent` and `applySlackPage` are the SAME
// functions, with the subscription, the flush timer and the workspace write
// taken off them. `src/bot/useConversationCapture.ts` is now only the
// subscription, and it writes nothing.
//
// A ROW IS A THREAD. The node answers in a thread created from the question
// message, and Discord gives that thread the SAME id as the question — see
// `findRowFor` in `src/eval/events.ts`. Nothing about that changed.
//
// WHAT THE DATABASE ADDS, and the three things it changes:
//
// 1. SEQ ORDER, NOT ARRIVAL ORDER. Events are folded in `seq` order, so two
//    sessions that saw the same burst in different orders now produce the
//    same rows. The timestamp used for a fold is the event's own
//    `occurred_at`, not `Date.now()`, so a backfill reproduces the history
//    instead of stamping all of it with the moment the page opened.
// 2. A DEDUPE KEY ON THE ROW, NOT ON THE LOG. `dd_events` already refuses a
//    duplicate delivery by `(message_id, event_type, event_key)`, but two
//    capture components (the bot and the shadow branch) write with different
//    sources and the same key set, and a page boundary can re-read a row. The
//    fold therefore carries the same key and skips what it has already seen —
//    which is cheaper than relying on `insertEvalEvent`'s own idempotence and
//    covers the patches, which have none.
// 3. A SLACK PAGE IS READ FROM THE ESCALATION. Nothing writes a Slack page
//    row any more: the Slack tool is a shared node and stays as it is, and the
//    engine never reports what a tool call did. Instead the discord node labels
//    every row with the pipe that wrote it (`captureSource`), and a pipe that
//    can page Slack ends that label in `SLACK_PAGING_SUFFIX`. Its prompt pages
//    on the FIRST escalation in a thread, so the first escalation reply in a
//    thread from such a pipe is marked as the page — "a page was triggered",
//    never "Slack received it". `slack_page` rows written before this change
//    (imported from the task log) still fold, by the message id they name.
//
// Everything here is pure: no engine, no clock, no React. That is what lets
// `db.selftest.ts` run it in Node.
// =============================================================================

import { MAX_CONVERSATIONS } from '../state/types';
import type { BotSettings, ConversationRow } from '../state/types';
import { EMPTY_EVAL_FIELDS, evalContextOf, evalEventFor, findRowFor, slackPageEvent, withEvalEvent, type EvalContext } from '../eval/events';
import { isTeamMember } from '../eval/rules';
import { outcomeOfNoReply, outcomeOfReply, parseDiscordEvent } from '../bot/parseEvent';
import type { DiscordEvent } from '../bot/parseEvent';
import type { ApprovedQa, EventRow, ThreadState } from './repo';
import { SLACK_PAGING_SUFFIX } from './config';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The `event_type` of a Slack page row; only older, imported rows have one. */
export const SLACK_PAGE_TYPE = 'slack_page';

// =============================================================================
// ROW CONSTRUCTION — unchanged from the browser-side capture
// =============================================================================

/**
 * A fresh row for a question the fold has not seen before.
 *
 * The eval fields are seeded the way the reference bot's `upsertThread`
 * seeded its thread row: who opened it, whether they are on the team, and the
 * `internal` exclusion that follows from that.
 *
 * @param ev - The decoded node event.
 * @param ctx - The settings the team test reads.
 * @param now - Unix ms — the event's own `occurred_at`.
 * @returns The new row, outcome still `pending`.
 */
function newRow(ev: DiscordEvent, ctx: EvalContext, now: number): ConversationRow {
	const openerIsTeam = isTeamMember(ev.authorRoleIds, ev.authorId, ctx.teamRoleId, ctx.teamUserIds);
	return {
		...EMPTY_EVAL_FIELDS,
		id: ev.messageId,
		seenAt: now,
		channelId: ev.channelId,
		guildId: ev.guildId,
		threadId: ev.threadId,
		authorId: ev.authorId,
		authorName: ev.authorName,
		correlationId: ev.correlationId,
		question: ev.text ?? '',
		answer: null,
		outcome: 'pending',
		reason: null,
		attachments: ev.attachments,
		reactions: [],
		updatedAt: now,
		openerId: ev.authorId,
		openerIsTeam,
		// A question from the team is not support traffic, and the reference
		// marked it excluded at capture time rather than waiting for the grader.
		excludedReason: openerIsTeam ? 'internal' : null,
		lastActivityAt: ev.createdAt ?? now,
	};
}

/**
 * Apply one event's payload to a row.
 *
 * @param row - The row as it stands.
 * @param ev - The decoded node event.
 * @param isOpener - Whether this event is about the row's OWN message.
 * @param now - Unix ms.
 * @returns The patched row, or the same object when the event adds nothing.
 */
function patchRow(row: ConversationRow, ev: DiscordEvent, isOpener: boolean, now: number): ConversationRow {
	switch (ev.eventType) {
		case 'message': {
			// A retried text pass is the node asking the SAME question again
			// (`nonAnswerRetries`); it is counted, not logged.
			const retries = ev.retry !== null ? Math.max(row.retries ?? 0, ev.retry) : (row.retries ?? 0);
			// A follow-up in the thread is not this row's question and its author is
			// not this row's asker — the event log holds it instead, so none of the
			// identity fields move.
			if (!isOpener) return retries === (row.retries ?? 0) ? row : { ...row, retries, updatedAt: now };
			// Attachments arrive as their own objects, so a later object for the
			// same message can be the one that carries the text.
			if (ev.text === null && ev.attachments.length === 0 && retries === (row.retries ?? 0)) return row;
			return {
				...row,
				question: row.question || (ev.text ?? ''),
				attachments: ev.attachments.length > 0 ? ev.attachments : row.attachments,
				authorName: row.authorName ?? ev.authorName,
				guildId: row.guildId ?? ev.guildId,
				threadId: row.threadId ?? ev.threadId,
				retries,
				updatedAt: now,
			};
		}
		case 'outbound': {
			// The shadow capture branch runs with `sendResponses: false`, so its
			// outbound event is what the bot WOULD have said
			// (`destination: 'suppressed'`, no message ids). Once the answer the bot
			// really posted is on the row, the shadow one must not overwrite it.
			const posted = (row.replyMessageIds?.length ?? 0) > 0;
			if (ev.destination === 'suppressed' && posted) return row;
			return {
				...row,
				answer: ev.replyText ?? row.answer,
				replyMessageIds: ev.messageIds.length > 0 ? ev.messageIds : row.replyMessageIds,
				outcome: outcomeOfReply(ev.replyText),
				reason: null,
				// The node answers in a thread, so the outbound event is often the
				// first place the thread id appears.
				threadId: row.threadId ?? ev.threadId,
				updatedAt: now,
			};
		}
		case 'no_reply': {
			const outcome = outcomeOfNoReply(ev.reason);
			// A DELIBERATE silence about a follow-up does not reclassify the thread:
			// the bot staying out of a thread it has already escalated is the
			// escalation working, not the escalation being resolved, and "Needs
			// you" reads this outcome. The event log records the silence either way.
			const keep = !isOpener && outcome === 'quiet' && row.outcome !== 'pending';
			return {
				...row,
				outcome: keep ? row.outcome : outcome,
				reason: ev.reason,
				updatedAt: now,
			};
		}
		case 'reaction': {
			if (ev.emoji === null) return row;
			const has = row.reactions.includes(ev.emoji);
			if (ev.reactionAdded === has) return row;
			return {
				...row,
				reactions: ev.reactionAdded ? [...row.reactions, ev.emoji] : row.reactions.filter((e) => e !== ev.emoji),
				updatedAt: now,
			};
		}
		default:
			return row;
	}
}

/**
 * Append the eval event this node event stands for, if it stands for one.
 *
 * @param row - The row, already patched.
 * @param ev - The decoded node event.
 * @param role - Whether a `message` opens this row or follows up in its thread.
 * @param ctx - The settings the classification reads.
 * @param now - Unix ms.
 * @returns The row with the event logged, or the same row.
 */
function logEvent(row: ConversationRow, ev: DiscordEvent, role: 'opener' | 'follow_up', ctx: EvalContext, now: number): ConversationRow {
	const event = evalEventFor(ev, role, ctx, now);
	return event === null ? row : withEvalEvent(row, event);
}

/**
 * Fold one decoded event into the row list.
 *
 * Two things ride on every fold: the app's own `outcome` (what the bot DID,
 * which is what the current screens read) and the eval event log (what
 * HAPPENED, which is what the later stages label).
 *
 * @param rows - The current rows, oldest first.
 * @param ev - The decoded node event.
 * @param ctx - The settings the classification reads.
 * @param now - Unix ms.
 * @param limit - How many rows one session holds. {@link MAX_CONVERSATIONS}.
 * @returns The next rows, or the same array when nothing changed.
 */
export function applyDiscordEvent(rows: ConversationRow[], ev: DiscordEvent, ctx: EvalContext, now: number, limit: number = MAX_CONVERSATIONS): ConversationRow[] {
	const index = findRowFor(rows, ev);

	if (index === -1) {
		// A reaction on a message the log has no question for has no row to join,
		// and inventing one would put a question-less row in Conversations.
		if (ev.eventType === 'reaction') return rows;
		// An outcome event for a question that is not in this window still
		// deserves a row — dropping it would hide real traffic.
		const seeded = patchRow(newRow(ev, ctx, now), ev, true, now);
		const opened = logEvent(seeded, ev, 'opener', ctx, now);
		const trimmed = rows.length >= limit ? rows.slice(rows.length - limit + 1) : rows;
		return [...trimmed, opened];
	}

	const row = rows[index];
	// Whether this event is about the row's OWN message (its question and the
	// bot's response to it) or about something later in the thread.
	const isOpener = row.id === ev.messageId;
	const patched = logEvent(patchRow(row, ev, isOpener, now), ev, isOpener ? 'opener' : 'follow_up', ctx, now);
	if (patched === row) return rows;
	const next = rows.slice();
	next[index] = patched;
	return next;
}

/** Mark the row at `index` as having paged Slack. */
function markPaged(rows: ConversationRow[], index: number, now: number): ConversationRow[] {
	const row = rows[index];
	const logged = withEvalEvent(row, slackPageEvent(now));
	if (row.pagedSlack === true && logged === row) return rows;
	const next = rows.slice();
	next[index] = { ...logged, pagedSlack: true, updatedAt: now };
	return next;
}

/**
 * Mark the question the agent is answering right now as having paged Slack.
 *
 * The fallback, kept for an agent broadcast that carries no message id: the
 * page is attributed to the newest row still waiting for its answer, because
 * the discord node hands questions to the pipeline one at a time and the
 * `outbound` event that closes the row arrives after the tool call.
 *
 * @param rows - The current rows, oldest first.
 * @param now - Unix ms.
 * @returns The next rows, or the same array when nothing changed.
 */
export function applySlackPage(rows: ConversationRow[], now: number): ConversationRow[] {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		if (rows[index].outcome !== 'pending') continue;
		return markPaged(rows, index, now);
	}
	return rows;
}

/**
 * Fold a `slack_page` ROW, which knows which message it was about.
 *
 * The row's `message_id` is the Discord message the agent was answering,
 * parsed out of the current object's `discord://<channel>/<message>` url. It
 * matches a row's own id, or a message id anywhere in a row's event log (a
 * follow-up in the thread). Only when neither matches does it fall back to
 * {@link applySlackPage}'s guess.
 *
 * @param rows - The current rows, oldest first.
 * @param messageId - `dd_events.message_id`.
 * @param now - Unix ms.
 * @returns The next rows, or the same array when nothing changed.
 */
export function applySlackPageRow(rows: ConversationRow[], messageId: string, now: number): ConversationRow[] {
	if (messageId.length > 0) {
		const own = rows.findIndex((row) => row.id === messageId);
		if (own !== -1) return markPaged(rows, own, now);
		const inLog = rows.findIndex((row) => row.replyMessageIds?.includes(messageId) === true || (row.events ?? []).some((event) => event.message_id === messageId));
		if (inLog !== -1) return markPaged(rows, inLog, now);
	}
	return applySlackPage(rows, now);
}

/**
 * Mark the first escalation in a thread as the Slack page, when the pipe that
 * wrote it pages Slack.
 *
 * @param rows - The rows after the reply was folded.
 * @param ev - The decoded `outbound` event.
 * @param source - `dd_events.source` of the row it came from.
 * @param now - Unix ms.
 * @returns The next rows, or the same array when this reply is not a page.
 */
export function applyEscalationPage(rows: ConversationRow[], ev: DiscordEvent, source: string, now: number): ConversationRow[] {
	if (ev.eventType !== 'outbound' || ev.destination === 'suppressed') return rows;
	if (!source.endsWith(SLACK_PAGING_SUFFIX)) return rows;
	if (outcomeOfReply(ev.replyText) !== 'escalated') return rows;
	const index = findRowFor(rows, ev);
	// Only the first: a later escalation in the same thread is answered without
	// a second page, and marking it again would log a second one.
	if (index === -1 || rows[index].pagedSlack === true) return rows;
	return markPaged(rows, index, now);
}

// =============================================================================
// FOLDING A PAGE OF EVENTS
// =============================================================================

/**
 * Everything one fold has to carry between pages.
 *
 * The poll is incremental — it reads `seq > last` every five seconds — so the
 * rows are folded ONCE and then added to, rather than rebuilt from the whole
 * log on every tick.
 */
export interface FoldState {
	/** The rows so far, oldest first. */
	rows: ConversationRow[];
	/** The dedupe keys already folded. */
	seen: Set<string>;
	/** The highest `seq` folded. What the next read asks for. */
	seq: number;
}

/** A fold that has seen nothing. */
export function emptyFold(): FoldState {
	return { rows: [], seen: new Set<string>(), seq: 0 };
}

/** The key `dd_events` deduplicates on, as a string. */
function keyOf(event: EventRow): string {
	return `${event.messageId} ${event.eventType} ${event.eventKey}`;
}

/**
 * Fold one page of events onto a state.
 *
 * The state is never mutated: a new one is returned, so React state and the
 * self-test can both hold on to the old one.
 *
 * @param state - What has been folded so far.
 * @param events - The next page, in `seq` order.
 * @param settings - The settings the classification reads.
 * @param limit - How many rows one session holds.
 * @returns The next state.
 */
export function foldEvents(state: FoldState, events: EventRow[], settings: BotSettings, limit: number = MAX_CONVERSATIONS): FoldState {
	if (events.length === 0) return state;
	const ctx = evalContextOf(settings);
	const seen = new Set(state.seen);
	let rows = state.rows;
	let seq = state.seq;

	for (const event of events) {
		if (event.seq > seq) seq = event.seq;
		const key = keyOf(event);
		if (seen.has(key)) continue;
		seen.add(key);

		// The event's OWN time, not the clock: a cold start folds months of
		// history, and stamping all of it with `Date.now()` would make every
		// thread look like it had just moved — which is exactly what "quiet
		// enough to grade" reads.
		const now = event.occurredAt > 0 ? event.occurredAt : Date.now();

		if (event.eventType === SLACK_PAGE_TYPE) {
			rows = applySlackPageRow(rows, event.messageId, now);
			continue;
		}

		// The payload IS the SSE body the node broadcasts, so the browser's own
		// decoder reads it unchanged — which is what keeps a row folded from the
		// database identical to one folded from a live push.
		const decoded = parseDiscordEvent({ type: 'discord', data: event.payload });
		if (decoded === null) continue;
		rows = applyDiscordEvent(rows, decoded, ctx, now, limit);
		rows = applyEscalationPage(rows, decoded, event.source, now);
	}

	return { rows, seen, seq };
}

// =============================================================================
// THE OVERLAY
// =============================================================================

/**
 * Put one thread's stored eval state onto its row.
 *
 * `excludedReason` and `qaDraft` are `??`, not `=`: capture decides the
 * `internal` exclusion at fold time and the grader may never have run, so a
 * null column must not clear what the fold already knows.
 *
 * A GRADED ROW REOPENS when an event arrived after the grade. That is the
 * reference's `reopenThread`, which the live capture got for free from
 * `withEvalEvent` and which has to be stated here because the overlay runs
 * AFTER the events: `lastActivityAt > gradedAt` is the same test. A REVIEWED
 * row is a human's decision and stays.
 *
 * @param row - The folded row.
 * @param state - Its `dd_threads` row.
 * @returns The row with the stored state on it.
 */
function overlayThread(row: ConversationRow, state: ThreadState): ConversationRow {
	const lastActivity = row.lastActivityAt ?? row.updatedAt;
	const reopened = state.evalStatus === 'graded' && state.gradedAt !== null && lastActivity > state.gradedAt;
	return {
		...row,
		evalStatus: reopened ? 'open' : state.evalStatus,
		evalOutcome: state.outcome,
		evalCause: state.cause,
		outcomeSource: state.outcomeSource,
		causeSource: state.causeSource,
		excludedReason: state.excludedReason ?? row.excludedReason ?? null,
		qaDraft: state.qaDraft ?? row.qaDraft ?? null,
		grade:
			state.gradedAt === null
				? (row.grade ?? null)
				: {
						graderJson: state.graderJson ?? '',
						qTopScore: state.qTopScore,
						aTopScore: state.aTopScore,
						clusterId: state.clusterId,
						gradedAt: state.gradedAt,
					},
		reviewedBy: state.reviewedBy,
		reviewedAt: state.reviewedAt,
		replay: state.replay,
	};
}

/**
 * Put the stored eval state and the approved Q/A onto the folded rows.
 *
 * Both are keyed on the THREAD, which for a row is its own id — a thread
 * created from a question carries the question's message id. A row whose
 * `threadId` differs (a question asked inside an existing thread) is matched
 * on that too, so a state written against either id lands.
 *
 * @param rows - The folded rows.
 * @param threads - Every `dd_threads` row.
 * @param approved - The newest approved pair per thread.
 * @returns The rows, overlaid.
 */
export function overlayThreads(rows: ConversationRow[], threads: ThreadState[], approved: ApprovedQa[]): ConversationRow[] {
	if (threads.length === 0 && approved.length === 0) return rows;
	const byThread = new Map(threads.map((state) => [state.threadId, state]));
	const qaByThread = new Map(approved.filter((pair) => pair.threadId !== null).map((pair) => [pair.threadId as string, pair]));

	return rows.map((row) => {
		const state = byThread.get(row.id) ?? (row.threadId === null ? undefined : byThread.get(row.threadId));
		const pair = qaByThread.get(row.id) ?? (row.threadId === null ? undefined : qaByThread.get(row.threadId));
		let next = state === undefined ? row : overlayThread(row, state);
		if (pair !== undefined) {
			next = {
				...next,
				qaApproved: {
					question: pair.question,
					answer: pair.answer,
					approvedBy: pair.approvedBy,
					approvedAt: pair.approvedAt,
					ingestedAt: pair.ingestedAt,
				},
			};
		}
		return next;
	});
}

// =============================================================================
// API
// =============================================================================

/**
 * The conversation rows the database describes.
 *
 * The whole pipeline in one call: decode and fold every event in `seq` order,
 * then overlay what the app has written about each thread. Pure, so the
 * self-test runs it over literals.
 *
 * @param events - `dd_events` rows, in `seq` order.
 * @param threads - `dd_threads` rows.
 * @param settings - The settings the classification reads.
 * @param approved - The newest approved Q/A pair per thread.
 * @returns The rows, oldest first.
 */
export function rowsFromDatabase(events: EventRow[], threads: ThreadState[], settings: BotSettings, approved: ApprovedQa[] = []): ConversationRow[] {
	return overlayThreads(foldEvents(emptyFold(), events, settings).rows, threads, approved);
}
