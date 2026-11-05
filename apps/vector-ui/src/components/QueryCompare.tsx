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
// VECTOR-UI — QueryCompare (Search's Compare: two questions side by side)
// =============================================================================
//
// Runs A and B in two columns, each row saying whether the other run found
// it too, under one line that says how far they agree ("A and B share 4 of
// 10 results (Jaccard 0.25); 3 documents only in A, 2 only in B"). "Show A ★
// and B ☆ on the map" tells the map both questions so it can place a star
// for each (adapters/consoleActions.ts showCompareOnMap). The letters, not
// colours, tell the runs apart; chunk text is a React child, never markup.
// A column whose question is the one "Open in Search" brought says so and
// marks the chunks the chat's answer cited; the other column does not.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import type { IScoreInfo } from '../contract/types';
import { compareRuns, compareSentence, rowKey, sideOf } from '../vector/compare';
import type { CompareSide, CompareSummary } from '../vector/compare';
import { STATUS_WORDS, fromChatLine, runCaption, scoreTitle } from '../vector/searchWorkbench';
import type { Classification, WorkbenchRow, WorkbenchRun } from '../vector/searchWorkbench';

/** One side of the comparison: the run and its rows at the slider. */
export interface QueryCompareSide {
	run: WorkbenchRun;
	view: Classification;
}

/** Props of {@link QueryCompare}. */
export interface QueryCompareProps {
	a: QueryCompareSide;
	b: QueryCompareSide;
	score: IScoreInfo | null;
	/** Show both questions and their results on the map. */
	onShowBoth(): void;
	/** Open a row's document at its chunk. */
	onOpen(row: WorkbenchRow): void;
	/** Run searches within the console's scope (for the "From the chat" line). */
	scopeOn?: boolean;
}

/** The star each run gets on the map. */
const STARS = { A: '★', B: '☆' } as const;

/** Whether the other run found the row too, in the "Also in" column. */
const SIDE_WORDS: Record<CompareSide, string> = { both: 'yes', 'only-a': 'no', 'only-b': 'no' };

const S = {
	root: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } as CSSProperties,
	summary: { margin: 0, fontSize: 12, color: 'var(--rr-text-primary)' } as CSSProperties,
	columns: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, alignItems: 'start' } as CSSProperties,
	side: { border: '1px solid var(--rr-border)', borderRadius: 6, padding: '6px 8px', minWidth: 0 } as CSSProperties,
	title: { margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--rr-text-primary)', overflowWrap: 'anywhere' } as CSSProperties,
	line: { margin: '2px 0', fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } as CSSProperties,
	th: { textAlign: 'left', fontWeight: 600, color: 'var(--rr-text-secondary)', padding: '2px 4px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	td: { padding: '2px 4px', borderBottom: '1px solid var(--rr-border)', verticalAlign: 'top', overflowWrap: 'anywhere' } as CSSProperties,
	muted: { color: 'var(--rr-text-secondary)' } as CSSProperties,
	button: { ...commonStyles.buttonSecondary, padding: '1px 8px', fontSize: 11 } as CSSProperties,
	link: { background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', textAlign: 'left', textDecoration: 'underline', cursor: 'pointer', overflowWrap: 'anywhere' } as CSSProperties,
};

/** Props of one column. */
interface SideProps {
	letter: 'A' | 'B';
	side: QueryCompareSide;
	summary: CompareSummary;
	score: IScoreInfo | null;
	onOpen(row: WorkbenchRow): void;
	scopeOn: boolean;
}

/**
 * One run's column.
 *
 * @param props - {@link SideProps}.
 * @returns The column.
 */
function Column({ letter, side, summary, score, onOpen, scopeOn }: SideProps): React.ReactElement {
	const { run, view } = side;
	const passing = view.counts.rated > 0 ? ` · ${view.counts.passing} of ${view.counts.rated} pass at ${view.at.toFixed(2)}` : '';
	const fromChat = fromChatLine(run, scopeOn);
	return (
		<section style={S.side} aria-label={`${letter}: ${run.question}`} data-run={letter}>
			<h4 style={S.title}>{`${letter} ${STARS[letter]} ${run.question}`}</h4>
			<p style={S.line}>{`${runCaption(run)}${passing}`}</p>
			{fromChat !== null && (
				<p style={S.line} data-from-chat="">
					{fromChat}
				</p>
			)}
			{view.rows.length === 0 ? (
				<p style={S.line}>{`No chunks matched “${run.question}”.`}</p>
			) : (
				<table style={S.table}>
					<caption style={{ ...S.line, textAlign: 'left' }}>{`Results of ${letter}, and whether ${letter === 'A' ? 'B' : 'A'} found them too`}</caption>
					<thead>
						<tr>
							<th scope="col" style={S.th}>
								#
							</th>
							<th scope="col" style={S.th}>
								Document
							</th>
							<th scope="col" style={S.th}>
								Score
							</th>
							<th scope="col" style={S.th}>
								{letter === 'A' ? 'Also in B' : 'Also in A'}
							</th>
						</tr>
					</thead>
					<tbody>
						{view.rows.map((row, index) => {
							const where = sideOf(summary, row.key, letter);
							const path = row.path || row.objectId;
							return (
								<tr key={rowKey(row.key, index)} data-status={row.status} data-side={where} style={row.status === 'used' || row.status === 'keyword' ? undefined : S.muted}>
									<td style={S.td}>{row.rank}</td>
									<td style={S.td} title={row.preview}>
										<button type="button" style={S.link} aria-label={`Open ${path} at chunk ${row.chunkId}`} onClick={() => onOpen(row)}>
											{`${path} #${row.chunkId}`}
										</button>
										{row.cited ? ' · cited' : ''}
									</td>
									<td style={S.td} title={`${scoreTitle(row, score)} · ${STATUS_WORDS[row.status]}`}>
										{row.score !== null ? row.score.toFixed(3) : 'match'}
									</td>
									<td style={S.td}>{SIDE_WORDS[where]}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
		</section>
	);
}

/**
 * Two searches side by side.
 *
 * @param props - {@link QueryCompareProps}.
 * @returns The comparison.
 */
export function QueryCompare({ a, b, score, onShowBoth, onOpen, scopeOn = false }: QueryCompareProps): React.ReactElement {
	const summary = compareRuns(a.run.rows, b.run.rows);
	return (
		<section style={S.root} aria-label="Compare A and B" data-component="QueryCompare">
			<p style={S.summary} role="status" data-compare-summary="">
				{compareSentence(summary)}
			</p>
			<div>
				<button type="button" style={S.button} onClick={onShowBoth}>
					{`Show A ${STARS.A} and B ${STARS.B} on the map`}
				</button>
			</div>
			<div style={S.columns}>
				<Column letter="A" side={a} summary={summary} score={score} onOpen={onOpen} scopeOn={scopeOn} />
				<Column letter="B" side={b} summary={summary} score={score} onOpen={onOpen} scopeOn={scopeOn} />
			</div>
		</section>
	);
}

export default QueryCompare;
