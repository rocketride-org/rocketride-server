// =============================================================================
// MIT License
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
// VECTOR-UI — STATS STRIP (the top of the Overview: what the collection holds)
// =============================================================================
//
// Renders the Overview's cards (vector/overview.ts overviewCards: "—" with a
// reason for what the store did not count, Size only where it is
// reported), the chips (each label carries its whole message), and "counts
// as of N s ago" after a quick refresh. While the first answer is pending it
// shows a skeleton; after a failure it keeps the last figures, in italics,
// marked "last known values" (the workbench's banner says what failed).
// While a scope is active a second line says what it covers ("Scope: 12 of
// 42 documents · 318 chunks (counted here)"). Only the "counts as of" words
// tick once a second (StatsAsOf).
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { IDialectResult } from '../contract/types';
import type { IStatsSlot } from '../vector/consoleStore';
import { TONE_EDGE } from '../vector/colors';
import { overviewCards } from '../vector/overview';
import { countsAsOfText, statsChips } from '../vector/stats';
import type { IHealthSummary } from '../vector/health';
import { styles } from '../styles';

const local = {
	strip: { padding: '10px 24px' } as CSSProperties,
	cards: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: 0 } as CSSProperties,
	card: { display: 'flex', flexDirection: 'column', minWidth: 104, padding: '6px 10px', border: '1px solid var(--rr-border)', borderRadius: 6, background: 'var(--rr-bg-paper)' } as CSSProperties,
	label: { ...styles.small, fontWeight: 600 } as CSSProperties,
	value: (long: boolean, stale: boolean): CSSProperties => ({ margin: 0, fontSize: long ? 13 : 18, fontWeight: 600, fontStyle: stale ? 'italic' : 'normal', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }),
	chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 } as CSSProperties,
	asOf: { ...styles.small, marginLeft: 'auto' } as CSSProperties,
	scope: { ...styles.small, marginTop: 6 } as CSSProperties,
};

/** Props for the {@link StatsStrip} component. */
export interface IStatsStripProps {
	stats: IStatsSlot;
	dialect: IDialectResult | null;
	readOnly: boolean;
	/** What the console's scope covers, while one is active (vector/filters.ts scopeStripText). */
	scopeLine?: string | null;
	/** The loaded documents' health, for the "N need attention" chip. */
	health?: IHealthSummary | null;
}

/** Re-render once a second so "counts as of N s ago" stays true. */
function useNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	return now;
}

/**
 * "counts as of N s ago" (or "last known values", "Refreshing…"): the only
 * part of the strip on the one-second clock, so a tick re-renders these words
 * alone, never the cards.
 *
 * @param props - The stats answer, and whether it is stale or refreshing.
 * @returns The words.
 */
export function StatsAsOf({ view, stale, refreshing }: { view: IStatsSlot['view']; stale: boolean; refreshing: boolean }): React.ReactElement {
	const now = useNow();
	const asOf = countsAsOfText(view, now);
	return (
		<span style={local.asOf} aria-live="off">
			{stale ? 'last known values' : refreshing ? 'Refreshing…' : (asOf ?? '')}
		</span>
	);
}

/**
 * The strip. It keeps no state of its own: the clock lives in {@link StatsAsOf}.
 *
 * @param props - {@link IStatsStripProps}.
 * @returns The strip element.
 */
export function StatsStrip({ stats, dialect, readOnly, scopeLine = null, health = null }: IStatsStripProps): React.ReactElement {
	const cards = overviewCards(stats.view, dialect);
	const chips = statsChips({ dialect, stats: stats.view, readOnly, health });
	const pending = stats.view === null && stats.status !== 'error';
	const stale = stats.status === 'error' && stats.view !== null;
	return (
		<section aria-label="Database summary" style={local.strip}>
			<dl style={local.cards} aria-busy={pending}>
				{cards.map((card) => (
					<div key={card.key} style={local.card} title={card.tooltip ?? undefined}>
						<dt style={local.label}>{card.label}</dt>
						<dd style={local.value(card.key === 'model' || card.key === 'index', stale)} data-figure={card.key} data-missing={card.missing ? 'true' : undefined}>
							{pending ? '…' : card.value}
						</dd>
					</div>
				))}
			</dl>
			<div style={local.chips}>
				{chips.map((chip) => (
					<span key={chip.key} style={styles.chip(TONE_EDGE[chip.tone])} title={chip.tooltip ?? undefined} data-chip={chip.key}>
						{chip.label}
					</span>
				))}
				<StatsAsOf view={stats.view} stale={stale} refreshing={stats.status === 'loading' && stats.view !== null} />
			</div>
			{scopeLine !== null && (
				<div role="status" style={local.scope} data-scope-line="">
					{scopeLine}
				</div>
			)}
		</section>
	);
}

export default StatsStrip;
