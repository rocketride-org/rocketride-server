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
// VECTOR-UI — STATS STRIP (R2: how many documents, chunks and more, at the top of the console)
// =============================================================================
//
// Renders vector/stats.ts: six figures ("—" with a reason for what the store
// did not count), the chips (each label carries its whole message), and
// "counts as of N s ago" after a quick refresh. While the first answer is
// pending it shows a skeleton; after a failure it keeps the last figures,
// marked "last known", under the shell's error banner. The Charts disclosure
// at the end, collapsed by default, holds the collection's charts. While a
// scope is active a second line says what it covers ("Scope: 12 of 42
// documents · 318 chunks (counted here)"). Only the "counts as of" words tick
// once a second (StatsAsOf); the charts are memoised, so the clock never
// draws them again.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { Banner } from 'shell';
import type { IDialectResult, IDocumentItem, IDocumentsFilter, ISampleModel } from '../contract/types';
import type { IStatsSlot } from '../vector/consoleStore';
import { TONE_EDGE } from '../vector/colors';
import { countsAsOfText, statsChips, statsFigures } from '../vector/stats';
import type { IHealthSummary } from '../vector/health';
import { styles } from '../styles';
import StatsCharts from './StatsCharts';

/** Props for the {@link StatsStrip} component. */
export interface IStatsStripProps {
	stats: IStatsSlot;
	dialect: IDialectResult | null;
	readOnly: boolean;
	/** The directory rows loaded so far (the charts read them). */
	documents?: readonly IDocumentItem[];
	/** What the console's scope covers, while one is active (vector/filters.ts scopeStripText). */
	scopeLine?: string | null;
	/** The map's sample, for the chunk-length chart. */
	sample?: ISampleModel | null;
	/** The directory is still loading pages. */
	loading?: boolean;
	/** The scope's conditions (the charts mark the bar they select). */
	scopeFilter?: IDocumentsFilter | null;
	/** A chart's bar was clicked: scope the directory to it. */
	onScope?(filter: IDocumentsFilter): void;
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
 * alone, never the figures or the charts.
 *
 * @param props - The stats answer, and whether it is stale or refreshing.
 * @returns The words.
 */
export function StatsAsOf({ view, stale, refreshing }: { view: IStatsSlot['view']; stale: boolean; refreshing: boolean }): React.ReactElement {
	const now = useNow();
	const asOf = countsAsOfText(view, now);
	return (
		<span style={{ ...styles.small, marginLeft: 'auto' }} aria-live="off">
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
export function StatsStrip({ stats, dialect, readOnly, documents = [], scopeLine = null, sample = null, loading = false, scopeFilter = null, onScope, health = null }: IStatsStripProps): React.ReactElement {
	const figures = statsFigures(stats.view, dialect);
	const chips = statsChips({ dialect, stats: stats.view, readOnly, health });
	const pending = stats.view === null && stats.status !== 'error';
	const stale = stats.status === 'error' && stats.view !== null;
	// An empty collection has nothing to chart: the disclosure is left out.
	const empty = stats.view !== null && (stats.view.collectionExists === false || stats.view.documents === 0) && documents.length === 0;
	return (
		<section aria-label="Database summary" style={{ padding: '10px 24px', borderBottom: '1px solid var(--rr-border)' }}>
			{stats.status === 'error' && stats.error && (
				<div style={{ marginBottom: 8 }}>
					<Banner variant="error">
						{stats.error.headline}
						{stats.error.detail ? ` ${stats.error.detail}` : ''}
					</Banner>
				</div>
			)}
			<dl style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 22px', margin: 0 }} aria-busy={pending}>
				{figures.map((f) => (
					<div key={f.key} style={{ display: 'flex', flexDirection: 'column', minWidth: 72 }} title={f.tooltip ?? undefined}>
						<dt style={{ ...styles.small, fontWeight: 600 }}>{f.label}</dt>
						<dd style={{ margin: 0, fontSize: f.key === 'model' || f.key === 'metric' ? 13 : 18, fontWeight: 600, fontStyle: stale ? 'italic' : 'normal' }} data-figure={f.key} data-missing={f.missing ? 'true' : undefined}>
							{pending ? '…' : f.value}
						</dd>
					</div>
				))}
			</dl>
			<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 }}>
				{chips.map((chip) => (
					<span key={chip.key} style={styles.chip(TONE_EDGE[chip.tone])} title={chip.tooltip ?? undefined} data-chip={chip.key}>
						{chip.label}
					</span>
				))}
				<StatsAsOf view={stats.view} stale={stale} refreshing={stats.status === 'loading' && stats.view !== null} />
				{!empty && (
					<details style={styles.small}>
						<summary style={{ cursor: 'pointer' }}>Charts</summary>
						<StatsCharts rows={documents} total={stats.view?.documents ?? null} sample={sample} dialect={dialect} onScope={onScope} loading={loading} scope={scopeFilter} />
					</details>
				)}
			</div>
			{scopeLine !== null && (
				<div role="status" style={{ ...styles.small, marginTop: 6 }} data-scope-line="">
					{scopeLine}
				</div>
			)}
		</section>
	);
}

export default StatsStrip;
