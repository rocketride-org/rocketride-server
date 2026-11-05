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
// VECTOR-UI — ScoreHistogram ("Why these?": where the scores fall)
// =============================================================================
//
// 100 bins over the score range with the threshold and floor drawn as lines.
// In Search the threshold is the slider's position, and the store node's own
// setting is drawn as a third line while the slider is away from it. An SVG
// with a text alternative: the same counts are in the table beside it, and
// the label states the range and the lines.
// =============================================================================

import React from 'react';
import { scoreHistogram } from '../vector/retrieval';

/** Props of {@link ScoreHistogram}. */
export interface ScoreHistogramProps {
	scores: readonly number[];
	/** dialect.score.range, else the scores' own span. */
	range: readonly [number, number] | null;
	threshold: number | null;
	floor: number | null;
	/** The store node's own threshold, drawn as a third line when it differs from `threshold` (Search's slider). */
	setting?: number | null;
}

const WIDTH = 300;
const HEIGHT = 56;

/**
 * The histogram.
 *
 * @param props - {@link ScoreHistogramProps}.
 * @returns An SVG.
 */
export function ScoreHistogram({ scores, range, threshold, floor, setting = null }: ScoreHistogramProps): React.ReactElement {
	const histogram = scoreHistogram(scores, range);
	const peak = Math.max(1, ...histogram.bins);
	const binWidth = WIDTH / histogram.bins.length;
	const x = (value: number): number => ((value - histogram.min) / (histogram.max - histogram.min)) * WIDTH;
	const showSetting = setting !== null && Number.isFinite(setting) && (threshold === null || Math.round(setting * 100) !== Math.round(threshold * 100));
	const lines = [threshold !== null ? `threshold ${threshold.toFixed(2)}` : null, floor !== null ? `floor ${floor.toFixed(2)}` : null, showSetting ? `node setting ${(setting as number).toFixed(2)}` : null].filter(Boolean).join(', ');
	const label = `Scores of ${scores.length} results from ${histogram.min.toFixed(2)} to ${histogram.max.toFixed(2)}${lines ? `; ${lines}` : ''}.`;
	return (
		<svg viewBox={`0 0 ${WIDTH} ${HEIGHT + 12}`} width="100%" height={HEIGHT + 12} role="img" aria-label={label} preserveAspectRatio="none" style={{ display: 'block', maxWidth: 420 }}>
			<line x1={0} y1={HEIGHT} x2={WIDTH} y2={HEIGHT} stroke="var(--rr-border)" strokeWidth={1} />
			{histogram.bins.map((count, index) => (count === 0 ? null : <rect key={index} x={index * binWidth + 0.2} y={HEIGHT - (count / peak) * (HEIGHT - 4)} width={Math.max(0.6, binWidth - 0.4)} height={(count / peak) * (HEIGHT - 4)} fill="var(--rr-border-focus)" />))}
			{threshold !== null && threshold >= histogram.min && threshold <= histogram.max && <line x1={x(threshold)} y1={0} x2={x(threshold)} y2={HEIGHT} stroke="var(--rr-text-primary)" strokeWidth={1} strokeDasharray="3 2" data-line="threshold" />}
			{floor !== null && floor >= histogram.min && floor <= histogram.max && <line x1={x(floor)} y1={0} x2={x(floor)} y2={HEIGHT} stroke="var(--rr-color-error)" strokeWidth={1} data-line="floor" />}
			{showSetting && (setting as number) >= histogram.min && (setting as number) <= histogram.max && <line x1={x(setting as number)} y1={0} x2={x(setting as number)} y2={HEIGHT} stroke="var(--rr-text-secondary)" strokeWidth={1} strokeDasharray="1 2" data-line="setting" />}
			<text x={0} y={HEIGHT + 10} fontSize={9} fill="var(--rr-text-secondary)">
				{histogram.min.toFixed(2)}
			</text>
			<text x={WIDTH} y={HEIGHT + 10} fontSize={9} fill="var(--rr-text-secondary)" textAnchor="end">
				{histogram.max.toFixed(2)}
			</text>
		</svg>
	);
}

export default ScoreHistogram;
