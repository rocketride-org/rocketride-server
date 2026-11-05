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
// VECTOR-UI — SourcesPanel (the chunks an answer cites)
// =============================================================================
//
// One row per cited chunk, in the order the store ranked them: rank, path,
// chunk number, the driver's score (its formula on hover), the chunk text
// behind a disclosure, and two ways back into the console — "open" (the
// document tab at that chunk) and "map" (the chunk highlighted on the map).
// Chunk text is a React child, never markup.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import type { IChatSource, SourcesPanelProps } from '../contract/types';

export type { SourcesPanelProps };

/** Characters of chunk text shown before the disclosure is opened. */
const PREVIEW_CHARS = 140;

const S = {
	list: { listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 } as CSSProperties,
	row: { display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', columnGap: 6, alignItems: 'start', fontSize: 12, padding: '4px 0', borderTop: '1px solid var(--rr-border)' } as CSSProperties,
	rank: { color: 'var(--rr-text-secondary)', textAlign: 'right' } as CSSProperties,
	path: { color: 'var(--rr-text-primary)', overflowWrap: 'anywhere' } as CSSProperties,
	meta: { color: 'var(--rr-text-secondary)', marginLeft: 6, whiteSpace: 'nowrap' } as CSSProperties,
	actions: { display: 'flex', gap: 4 } as CSSProperties,
	button: { ...commonStyles.buttonSecondary, padding: '1px 8px', fontSize: 11 } as CSSProperties,
	details: { gridColumn: '2 / span 2', color: 'var(--rr-text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as CSSProperties,
	summary: { cursor: 'pointer' } as CSSProperties,
};

/**
 * The score as shown, with what it means on hover.
 *
 * @param source - The cited chunk.
 * @param score - dialect.score, or null.
 * @returns Text and tooltip.
 */
export function scoreText(source: IChatSource, score: SourcesPanelProps['score']): { text: string; title: string } {
	if (source.score === null) return { text: 'no score', title: 'The pipeline did not return a score for this chunk.' };
	const formula = score?.formula && score.formula !== 'unknown' ? ` (${score.formula}${score.higher_is_better === false ? ', lower is better' : ''})` : '';
	return { text: source.score.toFixed(2), title: `Score ${source.score}${formula}` };
}

/**
 * The cited chunks of an answer.
 *
 * @param props - The frozen props.
 * @returns The list, or a sentence when there is none.
 */
export function SourcesPanel({ sources, score, onOpen, onShowOnMap }: SourcesPanelProps): React.ReactElement {
	if (sources.length === 0) {
		return <p style={{ fontSize: 12, color: 'var(--rr-text-secondary)', margin: '4px 0 0' }}>The answer cited no stored chunks.</p>;
	}
	return (
		<ol style={S.list} aria-label="Sources of this answer">
			{sources.map((source) => {
				const shown = scoreText(source, score);
				const path = source.path !== '' ? source.path : source.objectId;
				const preview = source.text.length > PREVIEW_CHARS ? `${source.text.slice(0, PREVIEW_CHARS)}…` : source.text;
				return (
					<li key={`${source.objectId}#${source.chunkId}`} style={S.row}>
						<span style={S.rank}>{source.rank}</span>
						<span style={S.path}>
							{path}
							<span style={S.meta}>{`#${source.chunkId}`}</span>
							<span style={S.meta} title={shown.title}>
								{shown.text}
							</span>
						</span>
						<span style={S.actions}>
							<button type="button" style={S.button} aria-label={`Open ${path} at chunk ${source.chunkId}`} onClick={() => onOpen(source)}>
								open
							</button>
							<button type="button" style={S.button} aria-label={`Show chunk ${source.chunkId} of ${path} on the map`} onClick={() => onShowOnMap([source.key])}>
								map
							</button>
						</span>
						{source.text !== '' && (
							<details style={S.details}>
								<summary style={S.summary}>{preview}</summary>
								{source.text}
							</details>
						)}
					</li>
				);
			})}
		</ol>
	);
}

export default SourcesPanel;
