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
// QUALITY › SCORECARD — the weekly numbers, on a screen instead of in Discord
// =============================================================================
//
// The reference bot's weekly summary embed, which it posted to `#ralph-eval`
// every Monday at 09:00. Nothing is posted here and nothing is scheduled: the
// numbers are computed from the rows the app holds, every render, by
// `buildScorecard` in `src/eval/scorecard.ts`. This file is rendering only.
//
// The headline is deliberately THREE facts and not one: the rate, the target it
// is read against, and the size of the pending queue it is waiting on. A rate
// with 40 unreviewed threads behind it is not the same number as a rate with
// none, and showing it alone would invite exactly that mistake.
// =============================================================================

import React, { useMemo } from 'react';
import type { ReactNode } from 'react';
import { buildScorecard, pct, sharePct } from '../../eval/scorecard';
import type { EvalOutcome } from '../../eval/rules';
import type { AppData, QualityState } from '../../state/types';
import { formatAge, formatWhen } from '../../ui/parts';
import { BarList, Chip, DdCard, DdEmpty, Meter, PageHeader, StatTile, type BarItem } from '../../ui/dd';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The bar colour per eval outcome — the status language: resolved and
 * confirmed is good, resolved but unconfirmed is still in progress, a
 * hand-off to a human needs one, and a thread nobody answered failed.
 */
const OUTCOME_FILL: Record<EvalOutcome, BarItem['fill']> = {
	resolved_confirmed: 'ok',
	resolved_unconfirmed: 'info',
	deferred: 'warn',
	deferred_unanswered: 'warn',
	overridden: 'warn',
	reasked: 'warn',
	dead_end: 'bad',
	no_reply: 'bad',
	rejected: 'bad',
	excluded: 'muted',
};

/** Category hues, in rank order (cat-1 … cat-5). */
const CATS: BarItem['fill'][] = [1, 2, 3, 4, 5];

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link ScorecardTab}. */
export interface ScorecardTabProps {
	/** The app's persisted slice — the rows and the settings. */
	data: AppData;
	/** The quality slice to read: the sample pair in sample mode, else the real one. */
	quality: QualityState;
	/** Sample data is on, so the numbers describe made-up rows. */
	sampleMode: boolean;
	/** The Quality tabs, rendered under the page header. */
	nav: ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Scorecard tab: four tiles, then why.
 *
 * @param props - See {@link ScorecardTabProps}.
 * @returns The tab.
 */
export const ScorecardTab: React.FC<ScorecardTabProps> = ({ data, quality, sampleMode, nav }) => {
	const now = Date.now();
	const card = useMemo(
		() => buildScorecard({ rows: data.conversations, quality, settings: data.settings.eval, now }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[data.conversations, data.settings.eval, quality]
	);

	const rate = card.successRate === null ? '—' : `${(100 * card.successRate).toFixed(1)}%`;
	const target = `${(100 * card.target).toFixed(0)}%`;
	const subtitle = `How often Ralph resolves a thread on his own over the last ${card.windowDays} days, and what drives the misses.`;

	const header = <PageHeader title="Quality" subtitle={subtitle} actions={card.graded === 0 ? undefined : <Chip tone={card.meetsTarget ? 'ok' : 'warn'}>{card.meetsTarget ? `At or above target ${target}` : `Below target ${target}`}</Chip>} />;

	if (card.graded === 0) {
		return (
			<div className="dd-page">
				{header}
				{nav}
				<DdCard>
					<DdEmpty icon="gauge" title="Nothing graded yet" description={sampleMode ? 'Sample data has no eval labels, so there is nothing to score. Turn it off in Settings › Advanced.' : `Grade ungraded on the Test tab labels the captured threads that have gone quiet; the score is the trailing ${card.windowDays} days, which Settings › Eval sets.`} />
				</DdCard>
			</div>
		);
	}

	const range = card.interval === null ? 'n/a' : `${(100 * card.interval[0]).toFixed(1)}–${(100 * card.interval[1]).toFixed(1)}%`;

	return (
		<div className="dd-page">
			{header}
			{nav}

			{/* The four numbers. */}
			<div className="dd-stats">
				<StatTile label="Success rate" value={rate} tone={card.meetsTarget ? 'ok' : 'warn'} meter={<Meter value={card.successRate ?? 0} target={card.target} tone={card.meetsTarget ? 'ok' : 'warn'} label={`Success rate ${rate} against a ${target} target`} />} note={`${card.confirmed} of ${card.denom} decided · 95% Wilson ${range}`} />
				<StatTile label="Confirmed wins" value={card.confirmed} tone="ok" note="Asker confirmed the answer" />
				<StatTile label="Misses" value={card.failures} tone="bad" note={`${card.policyFloor.n} needed a human by policy`} />
				<StatTile label="Pending" value={card.pending} tone="info" note="Resolved, not confirmed yet — left out until reviewed" />
			</div>

			{/* The three caption lines, as one. Pending is in NEITHER half of the
			    fraction — see scorecard.ts. */}
			<p className="dd-caption" style={{ margin: '-6px 0 0' }}>
				{card.graded} graded threads of {card.population} captured in the window · last graded {card.lastGradedAt === null ? 'never' : formatAge(card.lastGradedAt, now)}
				{card.replay !== null && ` · last test ${pct(card.replay.passed, card.replay.total)} pass (${card.replay.passed} of ${card.replay.total}) from ${card.replay.fileName}, imported ${formatWhen(card.replay.importedAt)}`}
			</p>

			<div className="dd-grid-2">
				<DdCard title="Outcomes">
					<BarList
						items={card.outcomes.map((entry) => ({
							key: entry.outcome,
							label: entry.label,
							n: entry.n,
							fill: OUTCOME_FILL[entry.outcome as EvalOutcome] ?? 'muted',
						}))}
					/>
				</DdCard>
				<DdCard title="Failures by cause">
					{card.causes.length === 0 ? (
						<p className="dd-help">No failure in the window carries a cause.</p>
					) : (
						<BarList
							items={card.causes.map((entry, index) => ({
								key: entry.cause,
								label: `${entry.label}${entry.docGap ? ' · doc gap' : ''}`,
								n: entry.n,
								fill: CATS[Math.min(index, CATS.length - 1)],
							}))}
						/>
					)}
				</DdCard>

				<DdCard title="What the numbers mean">
					<dl className="dd-dl">
						{/* The share of misses no bot could have won: the score's own
						    ceiling, and the first number to check before asking why the
						    rate is not higher. */}
						<dt>Policy floor</dt>
						<dd>
							<strong className="dd-strong">{`${card.policyFloor.n} of ${card.denom} (${sharePct(card.policyFloor.share)})`}</strong> <span className="dd-muted">misses no bot could have won</span>
						</dd>
						<dt>Doc gaps</dt>
						<dd>
							<strong className="dd-strong">{card.docGaps}</strong> <span className="dd-muted">answers that were not in the knowledge base</span>
						</dd>
						{/* Of the failures a human confirmed the CAUSE of, how many the rules
						    already had right. */}
						<dt>Grader agreement</dt>
						<dd>
							{card.agreement.n === 0 ? (
								<span className="dd-muted">n/a — no reviewed failure has had its cause confirmed yet</span>
							) : (
								<>
									<strong className="dd-strong">{sharePct(card.agreement.share)}</strong>{' '}
									<span className="dd-muted">
										{card.agreement.agree} of {card.agreement.n} reviewed failures
									</span>
								</>
							)}
						</dd>
					</dl>
				</DdCard>
				<DdCard title={`Top clusters · last ${card.windowDays} days`}>
					{card.clusters.length === 0 ? (
						<p className="dd-help">The grader has not grouped any thread in this window into a cluster yet.</p>
					) : (
						<BarList
							items={card.clusters.map((entry, index) => ({
								key: entry.id,
								label: entry.label,
								n: entry.n,
								figure: `${entry.n} · ${sharePct(entry.failShare)} fail`,
								fill: CATS[Math.min(index, CATS.length - 1)],
							}))}
						/>
					)}
				</DdCard>
			</div>
		</div>
	);
};
