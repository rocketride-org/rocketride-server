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
// EVAL REVIEW — the human verdict, as pure row transforms
// =============================================================================
//
// A port of the reference bot's `eval/review.ts`, minus Discord. There the
// review surface was a card posted to `#ralph-eval` with three rows of
// components; here it is the Quality › Review tab, and the cards are rendered
// from the same four head states, the same button sets and the same eleven
// causes. Nothing about WHAT a click writes changed — `applyReview` is the
// reference's dynamic `UPDATE`, spelled as a function from a row to a row.
//
// Three things are worth reading before changing anything here.
//
// A REVIEW IS A SOURCE, NOT A LABEL. Every write stamps `outcomeSource` or
// `causeSource` to `'review'`, and the scorecard reads those stamps: the
// grader-agreement figure is "of the failures a human confirmed the cause of,
// how many did the rules already get right", so `confirm` on a failure
// deliberately RE-WRITES the identical cause. Without that re-write the thread
// never enters the agreement denominator, and the grader looks untested.
//
// TEACHING IS NOT A VERDICT. `approveQa` stamps the reviewer, the time and
// `evalStatus: 'reviewed'`, and touches neither the outcome nor the cause: a
// reviewer who writes the answer the bot should have given has said nothing
// about whether the miss was labelled correctly, and counting it as agreement
// would inflate the grader's score with clicks that never looked at the cause.
//
// THE GOLDEN CASE IS THE LASTING PART. The KB write makes the bot answer the
// next matching question; the golden case is what proves it still does in three
// months. Both come out of the one teach submit, which is why `goldenCaseFor`
// lives beside `approveQa` rather than in the replay stage.
// =============================================================================

import { isFailure, type EvalCause, type EvalOutcome } from './rules';
import type { ConversationRow, GoldenCase, GoldenExpectation } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The eleven causes, in the reference's declaration order. */
export const CAUSES: EvalCause[] = ['tool_error', 'engine_error', 'policy_public', 'policy_account', 'policy_other', 'product_defect', 'feature_request', 'content_gap', 'bad_answer', 'retrieval_miss', 'unknown'];

/**
 * Plain-language labels shown to reviewers — the reference's `CAUSE_LABELS`.
 *
 * The stored value stays the enum: these are what a human reads on the card and
 * in the cause select, and they are deliberately sentences rather than nouns,
 * because "content_gap" is not a thing anyone recognises at 9am.
 */
export const CAUSE_LABELS: Record<EvalCause, string> = {
	tool_error: 'Tool error (GitHub/HTTP fetch failed)',
	engine_error: 'Engine error (no reply / crash)',
	policy_public: 'Policy — public info, should have answered',
	policy_account: 'Policy — needs an account/human action',
	policy_other: 'Policy — other escalation',
	product_defect: 'Product bug',
	feature_request: 'Feature request (not built yet)',
	content_gap: 'Doc gap — answer not in the KB',
	bad_answer: 'Bad answer — had the info, still wrong',
	retrieval_miss: 'Retrieval miss — in KB but not surfaced',
	unknown: 'Unknown / needs a look',
};

/** Longest slice of the question the card shows — the reference's own clip. */
export const QUESTION_PREVIEW = 280;

/** Longest slice of the grader's summary the card shows. */
export const SUMMARY_PREVIEW = 300;

/** Longest text either teach field accepts — the reference's modal limit. */
export const TEACH_FIELD_LIMIT = 4000;

/** Where a "File a GitHub issue" link points. */
const ISSUE_BASE = 'https://github.com/rocketride-org/rocketride-server/issues/new?title=';

/** Longest issue URL the link carries, including the encoded title. */
const ISSUE_URL_LIMIT = 512;

/** How much of the question rides along in the issue title. */
const ISSUE_TITLE_LIMIT = 80;

// =============================================================================
// HEAD STATE
// =============================================================================

/** Which of the four cards a row renders as. */
export type ReviewHead = 'excluded' | 'success' | 'pending' | 'miss';

/**
 * The card a row gets.
 *
 * Keyed off the eval outcome exactly as the reference's `head` was: a
 * `resolved_unconfirmed` thread is `pending` (the bot answered and nothing
 * confirmed it), a `resolved_confirmed` one is a `success`, an `excluded` one is
 * out of the metric, and everything else is a miss.
 *
 * @param row - The graded or reviewed row.
 * @returns The head state.
 */
export function headOf(row: ConversationRow): ReviewHead {
	const outcome = row.evalOutcome ?? null;
	if (outcome === 'excluded') return 'excluded';
	if (outcome === 'resolved_confirmed') return 'success';
	if (outcome === 'resolved_unconfirmed') return 'pending';
	return 'miss';
}

/** The one-line prompt under each head — the reference's `head.line`. */
export const HEAD_LINE: Record<ReviewHead, string> = {
	excluded: 'Not counted. Put it back below if that was wrong.',
	success: 'Ralph handled this one. Flip it below if that’s wrong.',
	pending: 'Ralph answered, but nothing confirmed it worked. You decide.',
	miss: 'Ralph didn’t resolve this. Confirm it, flip it, or teach him the fix.',
};

/** The badge tone each head reads in. */
export const HEAD_VARIANT: Record<ReviewHead, 'muted' | 'success' | 'info' | 'error'> = {
	excluded: 'muted',
	success: 'success',
	pending: 'info',
	miss: 'error',
};

/**
 * The card's title.
 *
 * The reference's titles without their emoji — the words are the same, and a
 * miss still names its cause, with the suffix dropped when there is none.
 *
 * @param row - The row.
 * @returns The title.
 */
export function headTitle(row: ConversationRow): string {
	switch (headOf(row)) {
		case 'excluded':
			return 'Excluded from the metric';
		case 'success':
			return 'Counted as resolved (a win)';
		case 'pending':
			return 'Needs a verdict — did Ralph resolve this?';
		default: {
			const cause = row.evalCause ?? null;
			return cause === null ? 'Counted as a miss' : `Counted as a miss — ${CAUSE_LABELS[cause]}`;
		}
	}
}

// =============================================================================
// THE QUEUE
// =============================================================================

/** The filter chips over the queue. */
export type ReviewFilterId = 'needs_verdict' | 'misses' | 'wins' | 'excluded' | 'reviewed';

/** The chips, in the order they read. */
export const REVIEW_FILTERS: { id: ReviewFilterId; label: string }[] = [
	{ id: 'needs_verdict', label: 'Needs verdict' },
	{ id: 'misses', label: 'Misses' },
	{ id: 'wins', label: 'Wins' },
	{ id: 'excluded', label: 'Excluded' },
	{ id: 'reviewed', label: 'Reviewed' },
];

/**
 * What the tab starts on: the two piles that need a person.
 *
 * Reviewed rows are hidden while `reviewed` is off (see
 * {@link matchesReviewFilters}), so this is the reference's queue —
 * `resolved_unconfirmed` plus the failures — and nothing that has already been
 * decided.
 */
export const DEFAULT_REVIEW_FILTERS: ReviewFilterId[] = ['needs_verdict', 'misses'];

/** One chip's test. */
const FILTER_TESTS: Record<ReviewFilterId, (row: ConversationRow) => boolean> = {
	needs_verdict: (row) => row.evalOutcome === 'resolved_unconfirmed',
	misses: (row) => row.evalOutcome != null && isFailure(row.evalOutcome),
	wins: (row) => row.evalOutcome === 'resolved_confirmed',
	excluded: (row) => row.evalOutcome === 'excluded',
	reviewed: (row) => row.evalStatus === 'reviewed',
};

/**
 * Everything a reviewer could act on, newest activity first.
 *
 * The reference's `getReviewQueue` had a fourth condition — "no card posted
 * yet" — which existed only because a card was a Discord message that must not
 * be posted twice. There is no such thing here: the tab IS the queue, so the
 * condition is `graded` or `reviewed` with a label on it, and `reviewed` rows
 * stay so a verdict can be changed.
 *
 * Sample rows are never in the queue: they carry no eval fields, and a verdict
 * on fiction would be a real write.
 *
 * @param rows - The captured conversations.
 * @returns The queue.
 */
export function reviewQueue(rows: ConversationRow[]): ConversationRow[] {
	return rows
		.filter((row) => row.sample !== true)
		.filter((row) => row.evalStatus === 'graded' || row.evalStatus === 'reviewed')
		.filter((row) => row.evalOutcome != null)
		.sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt));
}

/**
 * Whether a queue row passes the chips.
 *
 * The chips are a UNION — any active one letting a row through is enough — with
 * one rule on top: an already-reviewed row is hidden unless `Reviewed` is on.
 * Without that rule the default pair would keep showing the rows the reviewer
 * just decided, which is the one thing a queue must not do.
 *
 * @param row - A queue row.
 * @param active - The chips that are on. Empty means "everything".
 * @returns Whether to show it.
 */
export function matchesReviewFilters(row: ConversationRow, active: ReviewFilterId[]): boolean {
	if (active.length === 0) return true;
	if (row.evalStatus === 'reviewed' && !active.includes('reviewed')) return false;
	return active.some((id) => FILTER_TESTS[id](row));
}

// =============================================================================
// WRITES
// =============================================================================

/** What one control changes. Anything omitted is left alone. */
export interface ReviewPatch {
	/** The new eval outcome. Also stamps `outcomeSource: 'review'`. */
	outcome?: EvalOutcome;
	/** The new cause. Also stamps `causeSource: 'review'`. */
	cause?: EvalCause;
	/** Why it is out of the metric. Also forces `evalOutcome: 'excluded'`. */
	excludedReason?: string;
}

/**
 * Apply a reviewer's decision to a row.
 *
 * The reference's `applyReview(threadId, fields, reviewer)`, field for field:
 * an `outcome` also writes `outcomeSource`, a `cause` also writes
 * `causeSource`, an `excludedReason` also forces the outcome to `excluded`, and
 * the reviewer, the time and `evalStatus: 'reviewed'` are written
 * unconditionally — which is what an empty patch is for (`confirm` on a
 * success: nothing changed, but a human looked).
 *
 * @param row - The row as it stands.
 * @param patch - What the control changes.
 * @param reviewer - Who clicked.
 * @param now - Unix ms.
 * @returns The reviewed row.
 */
export function applyReview(row: ConversationRow, patch: ReviewPatch, reviewer: string, now: number): ConversationRow {
	const next: ConversationRow = { ...row, reviewedBy: reviewer, reviewedAt: now, evalStatus: 'reviewed' };
	if (patch.outcome !== undefined) {
		next.evalOutcome = patch.outcome;
		next.outcomeSource = 'review';
	}
	if (patch.cause !== undefined) {
		next.evalCause = patch.cause;
		next.causeSource = 'review';
	}
	if (patch.excludedReason !== undefined) {
		next.excludedReason = patch.excludedReason;
		next.evalOutcome = 'excluded';
		next.outcomeSource = 'review';
	}
	return next;
}

/** The four verdict buttons, by what they mean rather than by their label. */
export type ReviewVerdict = 'resolve' | 'fail' | 'confirm' | 'exclude';

/**
 * The patch one verdict button writes.
 *
 * `confirm` is the interesting one and is the reference's own asymmetry: on a
 * FAILURE with a cause it re-writes the identical cause so the thread enters the
 * grader-agreement denominator, and on a success it writes nothing at all —
 * the row still becomes `reviewed`, because {@link applyReview} always stamps
 * that.
 *
 * @param row - The row being reviewed.
 * @param verdict - Which button was pressed.
 * @returns The patch to apply.
 */
export function patchForVerdict(row: ConversationRow, verdict: ReviewVerdict): ReviewPatch {
	switch (verdict) {
		case 'resolve':
			return { outcome: 'resolved_confirmed' };
		// A manual miss is ALWAYS stored as `rejected`: the reviewer is saying the
		// asker did not get what they came for, which is what that outcome means,
		// and the more specific failures are the rules' to decide.
		case 'fail':
			return { outcome: 'rejected' };
		case 'exclude':
			return { excludedReason: 'manual' };
		default: {
			const outcome = row.evalOutcome ?? null;
			const cause = row.evalCause ?? null;
			if (outcome !== null && isFailure(outcome) && cause !== null) return { cause };
			return {};
		}
	}
}

/** The verdict buttons one head offers, in the order they render. */
export const VERDICT_BUTTONS: Record<ReviewHead, { verdict: ReviewVerdict; label: string; variant: 'primary' | 'secondary' | 'danger' }[]> = {
	pending: [
		{ verdict: 'resolve', label: 'Ralph resolved it', variant: 'primary' },
		{ verdict: 'fail', label: 'Ralph missed it', variant: 'danger' },
		{ verdict: 'exclude', label: 'Not a real question', variant: 'secondary' },
	],
	success: [
		{ verdict: 'confirm', label: 'Yes, resolved', variant: 'primary' },
		{ verdict: 'fail', label: 'Actually a miss', variant: 'danger' },
		{ verdict: 'exclude', label: 'Not a real question', variant: 'secondary' },
	],
	// No exclude button: the row is already out of the metric, and the two
	// buttons that remain are the ways back in.
	excluded: [
		{ verdict: 'resolve', label: 'Ralph resolved it', variant: 'primary' },
		{ verdict: 'fail', label: 'Ralph missed it', variant: 'danger' },
	],
	miss: [
		{ verdict: 'confirm', label: 'Yes, a miss', variant: 'primary' },
		{ verdict: 'resolve', label: 'Actually resolved', variant: 'secondary' },
		{ verdict: 'exclude', label: 'Not a real question', variant: 'secondary' },
	],
};

/**
 * The one line a verdict says back.
 *
 * The reference's ephemeral notes, which are the only place the consequence of a
 * click is spelled out — "counts against the success rate" is the sentence that
 * stops a reviewer flipping rows to tidy the queue.
 *
 * @param row - The row as it was BEFORE the click.
 * @param verdict - Which button was pressed.
 * @returns The toast text.
 */
export function verdictNote(row: ConversationRow, verdict: ReviewVerdict): string {
	switch (verdict) {
		case 'resolve':
			return 'Marked resolved — now counts as a success.';
		case 'fail':
			return 'Marked as a miss — now counts against Ralph’s success rate.';
		case 'exclude':
			return 'Excluded — dropped from the metric (not a real question).';
		default: {
			const outcome = row.evalOutcome ?? null;
			const cause = row.evalCause ?? null;
			if (outcome !== null && isFailure(outcome)) {
				const named = cause === null ? '' : ` (${CAUSE_LABELS[cause]})`;
				return `Confirmed as a miss${named} — counts against Ralph’s success rate.`;
			}
			return 'Kept as resolved — counts as a success.';
		}
	}
}

// =============================================================================
// THE REVIEWED LINE
// =============================================================================

/**
 * The grader's own auto cause, out of the stored grader JSON.
 *
 * `_auto_cause` is written by `applyGradeToRow`, so this is what the RULES
 * decided before any human touched the row — the comparison both the reviewed
 * line and the scorecard's agreement figure are built on.
 *
 * @param row - The row.
 * @returns The auto cause, or null when there is none or the JSON is unreadable.
 */
export function autoCauseOf(row: ConversationRow): EvalCause | null {
	const json = row.grade?.graderJson ?? '';
	if (json.length === 0) return null;
	try {
		const parsed = JSON.parse(json) as { _auto_cause?: unknown };
		const cause = parsed._auto_cause;
		return typeof cause === 'string' ? (cause as EvalCause) : null;
	} catch {
		return null;
	}
}

/**
 * The grader's own one-line summary, out of the stored grader JSON.
 *
 * The card's "Why (grader)" field: the only part of the model's answer a
 * reviewer reads, clipped to {@link SUMMARY_PREVIEW}. An unreadable or absent
 * summary is null rather than an empty string, so the card can say "—" once
 * instead of rendering an empty row.
 *
 * @param row - The row.
 * @returns The summary, clipped, or null.
 */
export function graderSummaryOf(row: ConversationRow): string | null {
	const json = row.grade?.graderJson ?? '';
	if (json.length === 0) return null;
	try {
		const parsed = JSON.parse(json) as { summary?: unknown };
		const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
		return summary.length > 0 ? summary.slice(0, SUMMARY_PREVIEW) : null;
	} catch {
		return null;
	}
}

/**
 * What the card says a reviewer did, or null when nobody has.
 *
 * The reference's three-way choice, in its order: an outcome decided by review
 * wins; otherwise a cause changed by review; otherwise the reviewer agreed and
 * nothing moved. It deliberately carries NO timestamp — the useful fact is who
 * stands behind the label, not the minute they clicked.
 *
 * @param row - The row.
 * @returns The line, without the "Reviewed" label, or null.
 */
export function reviewedLine(row: ConversationRow): string | null {
	const by = row.reviewedBy ?? '';
	if (by.length === 0) return null;
	if (row.outcomeSource === 'review') {
		const outcome = row.evalOutcome ?? null;
		if (outcome === 'excluded') return `${by} excluded it — dropped from the metric`;
		if (outcome === 'resolved_confirmed') return `${by} marked this resolved — counts as a success`;
		return `${by} marked this a miss — counts against the success rate`;
	}
	const cause = row.evalCause ?? null;
	if (row.causeSource === 'review' && cause !== null && cause !== autoCauseOf(row)) {
		return `${by} set the reason to ${CAUSE_LABELS[cause]} — the verdict itself is unchanged`;
	}
	return `${by} confirmed the grader’s verdict — nothing was changed`;
}

// =============================================================================
// THE TAUGHT ANSWER
// =============================================================================

/** Where an approved Q/A pair is on its way to the knowledge base. */
export type KbState = 'adding' | 'in_kb' | 'not_reached';

/**
 * What the card says about an approved pair, or null when there is none.
 *
 * `pending` is the "a write is in flight for this row right now" flag the tab
 * holds: the KB write plus its landing check takes tens of seconds, and a card
 * that said nothing in the meantime would read as a submit that did nothing.
 *
 * @param row - The row.
 * @param pending - Whether a writeback is running for it.
 * @returns The state, or null when nothing was taught.
 */
export function kbStateOf(row: ConversationRow, pending: boolean): KbState | null {
	const approved = row.qaApproved ?? null;
	if (approved === null) return null;
	if (approved.ingestedAt !== null) return 'in_kb';
	return pending ? 'adding' : 'not_reached';
}

/** What each KB state reads as on the card. */
export const KB_STATE_TEXT: Record<KbState, string> = {
	adding: 'adding it to Ralph’s KB…',
	in_kb: 'in Ralph’s KB.',
	not_reached: 'not marked as reaching the KB — retry.',
};

/**
 * Whether a teach submit starts a FRESH pair rather than editing the held one.
 *
 * The reference's two regression-tested cases, both of which are silent data
 * loss when they are missing: with no draft at all a hand-written answer for a
 * thread the grader never drafted for reached nothing, and re-teaching an
 * already-ingested pair edited a row that the pending-pairs query would never
 * return again — so the edit never reached the KB.
 *
 * @param row - The row.
 * @returns Whether the submit must create a new pair.
 */
export function needsFreshPair(row: ConversationRow): boolean {
	const approved = row.qaApproved ?? null;
	if (approved === null) return true;
	return approved.ingestedAt !== null;
}

/**
 * Approve a Q/A pair on a row, and stamp the review.
 *
 * The reference's `approveQa` + `applyReview(threadId, {}, by)` in one
 * transform. `ingestedAt` is null by construction: approved means "eligible for
 * the KB", and only a verified landing sets the stamp — see
 * `teachApproved` in `src/eval/teach.ts`.
 *
 * The outcome, the cause and `causeSource` are deliberately untouched. Teaching
 * is not a verdict on the miss, and must not enter the grader-agreement figure.
 *
 * @param row - The row as it stands.
 * @param pair.question - The question as edited.
 * @param pair.answer - The answer as edited.
 * @param pair.approvedBy - Who taught it.
 * @param pair.now - Unix ms.
 * @returns The row with the approved pair and the review stamps.
 */
export function approveQa(row: ConversationRow, pair: { question: string; answer: string; approvedBy: string; now: number }): ConversationRow {
	return {
		...applyReview(row, {}, pair.approvedBy, pair.now),
		qaApproved: {
			question: pair.question,
			answer: pair.answer,
			approvedBy: pair.approvedBy,
			approvedAt: pair.now,
			ingestedAt: null,
		},
	};
}

// =============================================================================
// THE GOLDEN CASE
// =============================================================================

/**
 * The golden case a teach submit seeds.
 *
 * `expected` comes from the CAUSE, not from the answer: a thread that failed
 * because it needed an account or another human action is one the bot should
 * escalate, and a replay that answers it has regressed. Such a case therefore
 * carries no golden answer — there is nothing to judge an answer against.
 *
 * @param row - The row being taught.
 * @param question - The question as approved.
 * @param answer - The answer as approved.
 * @param now - Unix ms.
 * @returns The case to seed.
 */
export function goldenCaseFor(row: ConversationRow, question: string, answer: string, now: number): GoldenCase {
	const threadId = row.threadId ?? row.id;
	const cause = row.evalCause ?? null;
	const expected: GoldenExpectation = cause === 'policy_account' || cause === 'policy_other' ? 'escalate' : 'answer';
	return {
		id: `thread-${threadId}`,
		question,
		expected,
		goldenAnswer: expected === 'answer' ? answer : null,
		source: 'review',
		threadId,
		active: true,
		createdAt: now,
	};
}

/**
 * Put a case into the golden set, replacing the one for the same thread.
 *
 * Deduped by THREAD rather than by id or by question text: re-teaching a thread
 * is a correction to the case it already seeded, and two cases for one thread
 * would double its weight in every replay.
 *
 * @param golden - The set as it stands.
 * @param seeded - The case to add or replace.
 * @returns The new set, the replacement in place rather than appended.
 */
export function seedGoldenCase(golden: GoldenCase[], seeded: GoldenCase): GoldenCase[] {
	const at = golden.findIndex((entry) => entry.threadId === seeded.threadId);
	if (at === -1) return [...golden, seeded];
	const next = golden.slice();
	next[at] = seeded;
	return next;
}

// =============================================================================
// LINKS
// =============================================================================

/**
 * The Discord link for a thread, when the ids allow one.
 *
 * The reference's card link: the THREAD, not the message — `openRow`'s own
 * "Open in Discord" on Conversations points at the question message, and a
 * reviewer wants the conversation.
 *
 * @param row - The row.
 * @returns The URL, or null when there is no guild id.
 */
export function threadLink(row: ConversationRow): string | null {
	const guildId = row.guildId ?? '';
	const threadId = row.threadId ?? row.id;
	if (guildId.length === 0 || threadId.length === 0) return null;
	return `https://discord.com/channels/${guildId}/${threadId}`;
}

/**
 * The "File a GitHub issue" link.
 *
 * A LINK and nothing else, exactly as the reference had it: the app never
 * creates an issue, because an issue filed by a bot from a click nobody
 * confirmed is noise in someone else's tracker.
 *
 * @param question - The thread's question.
 * @returns The prefilled new-issue URL.
 */
export function issueUrlFor(question: string): string {
	const title = encodeURIComponent(`[support] ${question.slice(0, ISSUE_TITLE_LIMIT)}`);
	return `${ISSUE_BASE}${title}`.slice(0, ISSUE_URL_LIMIT);
}

// =============================================================================
// WHAT A VERDICT WRITES
// =============================================================================
//
// Nothing in this module writes. {@link applyReview} and {@link approveQa}
// are row transforms the Review tab uses to render what a click WOULD do; the
// write itself is `actions.applyReview` / `actions.teach`, which upserts
// `dd_threads` and appends to `dd_reviews` in one transaction (`src/db/
// repo.ts`). The two must agree about the `excludedReason` rule, and the
// comment on each says so.
