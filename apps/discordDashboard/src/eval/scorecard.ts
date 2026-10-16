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
// EVAL SCORECARD — the weekly numbers, as one pure function
// =============================================================================
//
// The reference bot's `buildWeeklySummary`, minus the embed: the same
// population, the same denominator and the same eight breakdowns, returned as a
// plain object the Scorecard tab renders. Nothing is posted anywhere.
//
// TWO RULES DECIDE EVERY NUMBER HERE, and both are easy to get wrong.
//
// PENDING IS IN NEITHER HALF OF THE FRACTION. A thread the bot answered and
// nobody confirmed (`resolved_unconfirmed`) is not a win and not a miss: it is a
// thread nobody has looked at. Counting it as a success flatters the bot;
// counting it as a failure punishes the bot for the reviewer's backlog. So
// `denom = confirmed + failures`, and the pending count is shown beside the rate
// as the size of the queue the number is waiting on.
//
// REVIEWED ROWS ARE STILL GRADED ROWS. The first review click moves a row from
// `graded` to `reviewed`, so a population that only accepted `graded` would lose
// every row a human ever touched — and would therefore report the score of the
// threads nobody checked. The reference had the same trap and the same comment.
// =============================================================================

import { isFailure, roundInterval, wilson, type EvalCause, type EvalOutcome } from './rules';
import { autoCauseOf, CAUSE_LABELS } from './review';
import type { ConversationRow, EvalSettings, GraderCluster, QualityState } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** One day in ms — the window is counted in days. */
const DAY_MS = 86_400_000;

/** How many clusters the tab lists. */
export const TOP_CLUSTERS = 5;

/** The ten eval outcomes in words, for the histogram. */
export const EVAL_OUTCOME_LABEL: Record<EvalOutcome, string> = {
	excluded: 'Excluded',
	deferred: 'Deferred — team answered',
	deferred_unanswered: 'Deferred — nobody answered',
	overridden: 'Overridden by the team',
	dead_end: 'Dead end',
	no_reply: 'No reply',
	rejected: 'Rejected by the asker',
	reasked: 'Re-asked',
	resolved_confirmed: 'Resolved — confirmed',
	resolved_unconfirmed: 'Resolved — unconfirmed',
};

// =============================================================================
// TYPES
// =============================================================================

/** One bar of the outcome histogram. */
export interface OutcomeCount {
	outcome: EvalOutcome;
	label: string;
	n: number;
}

/** One bar of the cause histogram. */
export interface CauseCount {
	cause: EvalCause;
	label: string;
	n: number;
	/** `content_gap`: the one cause that is a documentation job, not a bot job. */
	docGap: boolean;
}

/** One line of the cluster table. */
export interface ClusterCount {
	id: string;
	label: string;
	n: number;
	fail: number;
	/** `fail / n`, or null when the cluster somehow has no threads. */
	failShare: number | null;
}

/** Everything the Scorecard tab renders. */
export interface Scorecard {
	/** The trailing window, in days (`settings.eval.windowDays`). */
	windowDays: number;
	/** Rows created inside the window, sample rows excluded. */
	population: number;
	/** Of those, the ones with a label that counts. */
	graded: number;
	confirmed: number;
	failures: number;
	/** `resolved_unconfirmed`: answered, unconfirmed, nobody has reviewed it. */
	pending: number;
	/** `confirmed + failures`. Pending is in NEITHER half. */
	denom: number;
	/** `confirmed / denom` in [0,1], or null when the denominator is 0. */
	successRate: number | null;
	/** `settings.eval.target`. */
	target: number;
	/** Whether the rate is at or above the target. False when there is no rate. */
	meetsTarget: boolean;
	/** The 95% Wilson interval on the rate, rounded, or null. */
	interval: [number, number] | null;
	/** Outcomes by count, descending. */
	outcomes: OutcomeCount[];
	/** Causes of the failures by count, descending. */
	causes: CauseCount[];
	/** Misses no bot could have won: `policy_account + policy_other`. */
	policyFloor: { n: number; share: number | null };
	/** The five biggest clusters, with each one's failure share. */
	clusters: ClusterCount[];
	/** `content_gap` count — the documentation backlog. */
	docGaps: number;
	/**
	 * Of the failures a human confirmed the cause of, how many the rules already
	 * had right. `n` is the denominator; null share when nothing qualifies.
	 */
	agreement: { agree: number; n: number; share: number | null };
	/** When the last grading batch finished, or null. */
	lastGradedAt: number | null;
	/** The last imported replay run's pass rate, when there is one. */
	replay: { passed: number; total: number; rate: number | null; fileName: string; importedAt: number } | null;
}

/** What {@link buildScorecard} needs. */
export interface ScorecardInput {
	/** The captured conversations. */
	rows: ConversationRow[];
	/** The persisted quality slice — clusters, last-graded stamp, replay runs. */
	quality: QualityState;
	/** Settings › Eval: the window and the target. */
	settings: EvalSettings;
	/** Unix ms. */
	now: number;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * When a row was created.
 *
 * `seenAt` is when THIS app first saw an event for the message, which is the
 * row's creation time in every normal case. A row whose `seenAt` never got set
 * (a hand-edited slice, or a shape from before capture stamped it) falls back to
 * its first event, then to `updatedAt` — anything rather than 0, which would put
 * the row outside every window and silently shrink the population.
 *
 * @param row - The row.
 * @returns Unix ms.
 */
export function createdAtOf(row: ConversationRow): number {
	if (row.seenAt > 0) return row.seenAt;
	const events = row.events ?? [];
	let first = 0;
	for (const event of events) {
		if (event.ts > 0 && (first === 0 || event.ts < first)) first = event.ts;
	}
	return first > 0 ? first : row.updatedAt;
}

/**
 * A count as a percentage string, or a dash when there is nothing to divide by.
 *
 * The reference's `pct`, one decimal place — the shared formatter for every
 * share on the tab, so the headline rate and the cluster shares cannot disagree
 * about rounding.
 *
 * @param n - Numerator.
 * @param d - Denominator.
 * @returns e.g. `'62.5%'`, or `'—'`.
 */
export function pct(n: number, d: number): string {
	if (d <= 0) return '—';
	return `${((100 * n) / d).toFixed(1)}%`;
}

/** A share in [0,1] as a percentage string, or a dash for null. */
export function sharePct(share: number | null): string {
	return share === null ? '—' : `${(100 * share).toFixed(1)}%`;
}

/** The cluster label for a grade's cluster id — its label, its id, or a dash. */
function clusterLabelOf(id: string, clusters: GraderCluster[]): string {
	const held = clusters.find((cluster) => cluster.id === id);
	if (held !== undefined) return held.label;
	// The grader LLM's `cluster.id` is trusted verbatim, so a row can point at a
	// cluster that is in no list. Showing the dangling id beats showing nothing.
	return id.length > 0 ? `#${id}` : '—';
}

// =============================================================================
// THE NUMBERS
// =============================================================================

/**
 * Build the scorecard.
 *
 * @param input - See {@link ScorecardInput}.
 * @returns Every number the tab shows.
 */
export function buildScorecard(input: ScorecardInput): Scorecard {
	const { rows, quality, settings, now } = input;
	const windowDays = settings.windowDays;
	const cutoff = now - windowDays * DAY_MS;
	const clusters = quality.clusters ?? [];

	// The population: real rows created inside the window. Sample rows are out —
	// they carry no eval fields, and a fictional row in the denominator would
	// make the demo mode lie about the bot.
	const population = rows.filter((row) => row.sample !== true && createdAtOf(row) >= cutoff);

	// The graded set. `reviewed` counts: the first review click moves a row out
	// of `graded`, and dropping those would score only the unreviewed threads.
	const graded = population.filter((row) => (row.evalStatus === 'graded' || row.evalStatus === 'reviewed') && row.evalOutcome != null && row.evalOutcome !== 'excluded');

	let confirmed = 0;
	let failures = 0;
	let pending = 0;
	const outcomeCounts = new Map<EvalOutcome, number>();
	const causeCounts = new Map<EvalCause, number>();
	const clusterCounts = new Map<string, { n: number; fail: number }>();
	let agree = 0;
	let agreementN = 0;

	for (const row of graded) {
		const outcome = row.evalOutcome as EvalOutcome;
		const cause = row.evalCause ?? null;
		const failed = isFailure(outcome);

		if (outcome === 'resolved_confirmed') confirmed += 1;
		if (failed) failures += 1;
		if (outcome === 'resolved_unconfirmed') pending += 1;

		outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
		if (failed && cause !== null) causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);

		const clusterId = row.grade?.clusterId ?? '';
		if (clusterId.length > 0) {
			const held = clusterCounts.get(clusterId) ?? { n: 0, fail: 0 };
			clusterCounts.set(clusterId, { n: held.n + 1, fail: held.fail + (failed ? 1 : 0) });
		}

		// Grader agreement: only the failures whose CAUSE a human confirmed or
		// changed. `confirm` on a failure re-writes the same cause for exactly this
		// reason — see `patchForVerdict` in review.ts.
		if (failed && row.causeSource === 'review' && cause !== null) {
			agreementN += 1;
			if (autoCauseOf(row) === cause) agree += 1;
		}
	}

	const denom = confirmed + failures;
	const successRate = denom > 0 ? confirmed / denom : null;
	const policyN = (causeCounts.get('policy_account') ?? 0) + (causeCounts.get('policy_other') ?? 0);
	const lastRun = quality.lastRun;
	const passed = lastRun === null ? 0 : lastRun.seeds.filter((seed) => seed.status === 'pass').length;

	return {
		windowDays,
		population: population.length,
		graded: graded.length,
		confirmed,
		failures,
		pending,
		denom,
		successRate,
		target: settings.target,
		meetsTarget: successRate !== null && successRate >= settings.target,
		interval: roundInterval(wilson(confirmed, denom)),
		outcomes: [...outcomeCounts.entries()].map(([outcome, n]) => ({ outcome, label: EVAL_OUTCOME_LABEL[outcome], n })).sort((a, b) => b.n - a.n),
		causes: [...causeCounts.entries()].map(([cause, n]) => ({ cause, label: CAUSE_LABELS[cause], n, docGap: cause === 'content_gap' })).sort((a, b) => b.n - a.n),
		policyFloor: { n: policyN, share: denom > 0 ? policyN / denom : null },
		clusters: [...clusterCounts.entries()]
			.map(([id, counts]) => ({
				id,
				label: clusterLabelOf(id, clusters),
				n: counts.n,
				fail: counts.fail,
				failShare: counts.n > 0 ? counts.fail / counts.n : null,
			}))
			.sort((a, b) => b.n - a.n)
			.slice(0, TOP_CLUSTERS),
		docGaps: causeCounts.get('content_gap') ?? 0,
		agreement: { agree, n: agreementN, share: agreementN > 0 ? agree / agreementN : null },
		lastGradedAt: quality.lastGradedAt ?? null,
		replay:
			lastRun === null
				? null
				: {
						passed,
						total: lastRun.seeds.length,
						rate: lastRun.seeds.length > 0 ? passed / lastRun.seeds.length : null,
						fileName: lastRun.fileName,
						importedAt: lastRun.importedAt,
					},
	};
}
