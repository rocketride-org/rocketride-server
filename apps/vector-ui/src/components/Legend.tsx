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
// VECTOR-UI — Legend (what the map's colours and marks mean, and what it shows)
// =============================================================================
//
// Names every colour (colour is never the only carrier), states the sample line
// and the point cap of the mode, who computed the neighbour graph ("neighbour
// graph computed by Qdrant" when the store did it natively) and the caveat that
// 2D distances are approximate while ranks and scores are exact. Coloured by
// cluster it lists the largest groups and says how many more the Clusters tab
// lists; the view adds its lines (what a cluster is, the edges drawn, how the
// sample's listing ended, the scope, an isolation) as notes, and the draw again
// when the store refused to draw the sample for the console's scope.
// =============================================================================

import React from 'react';
import type { LegendProps as ContractLegendProps } from '../contract/types';
import type { IColouring, MapColourBy } from '../map/colours';
import { MAP_STYLES } from '../map/styles';
import { DISTANCE_CAVEAT, biasedNote, knnSourceLine, num, pointCapLine, sampleLabel } from '../map/wording';

/** Groups listed by name when coloured by cluster (the Clusters tab lists every one). */
export const LEGEND_CLUSTERS = 12;

/** Legend props: the frozen ones (Colour by widened) plus what the map computed. */
export interface LegendProps extends Omit<ContractLegendProps, 'colourBy'> {
	colourBy: MapColourBy;
	/** The current colouring (legend rows, ramp, note), when there is one. */
	colouring?: IColouring | null;
	/** Extra lines (query placement, layout notes). */
	notes?: readonly string[];
	/** Offered under the lines when the store refused to draw the sample for the console's scope. */
	scopeRetry?: { label: string; onClick(): void } | null;
}

/**
 * The map legend.
 *
 * @param props - Sample, colour mode, point cap, backend, colouring.
 * @returns The legend.
 */
export function Legend(props: LegendProps): React.ReactElement {
	const sample = props.sample.result;
	const colouring = props.colouring ?? null;
	const bias = biasedNote(sample);
	const rampStyle: React.CSSProperties | null = colouring?.ramp ? { height: 10, borderRadius: 3, background: `linear-gradient(to right, ${colouring.ramp.stops.join(', ')})`, margin: '4px 0' } : null;
	// Coloured by cluster: the largest groups by name, then the noise row; the rest are counted.
	const all = colouring?.legend ?? [];
	const groups = props.colourBy === 'cluster' ? all.filter((e) => e.key !== 'noise') : all;
	const rows = props.colourBy === 'cluster' ? [...groups.slice(0, LEGEND_CLUSTERS), ...all.filter((e) => e.key === 'noise')] : all;
	const more = props.colourBy === 'cluster' ? Math.max(0, groups.length - LEGEND_CLUSTERS) : 0;
	return (
		<section aria-label="Map legend" style={MAP_STYLES.legend} data-knn-source={sample.knn_source} data-colour-by={props.colourBy}>
			<p style={MAP_STYLES.note}>{sampleLabel(sample)}</p>
			{bias ? <p style={MAP_STYLES.note}>{bias}</p> : null}
			{rows.length > 0 ? (
				<ul aria-label="Colours" style={{ ...MAP_STYLES.list, display: 'flex', flexWrap: 'wrap', gap: '2px 14px', margin: '4px 0' }}>
					{rows.map((entry) => (
						<li key={entry.key} style={{ ...MAP_STYLES.small, display: 'inline-flex', alignItems: 'center' }}>
							<span aria-hidden="true" style={MAP_STYLES.swatch(entry.colour, entry.outlined)} />
							<span>{entry.label}</span>
							<span style={{ marginLeft: 4 }}>({num(entry.count)})</span>
						</li>
					))}
				</ul>
			) : null}
			{more > 0 ? <p style={MAP_STYLES.note}>{`and ${num(more)} more ${more === 1 ? 'group' : 'groups'}, each with its own colour (the Clusters tab lists them all)`}</p> : null}
			{colouring?.ramp && rampStyle ? (
				<div role="img" aria-label={`Colour ramp from ${colouring.ramp.low} to ${colouring.ramp.high}`} style={{ maxWidth: 320 }}>
					<div style={rampStyle} />
					<div style={{ ...MAP_STYLES.small, display: 'flex', justifyContent: 'space-between' }}>
						<span>{colouring.ramp.low}</span>
						<span>{colouring.ramp.high}</span>
					</div>
				</div>
			) : null}
			{colouring?.note ? <p style={MAP_STYLES.note}>{colouring.note}</p> : null}
			<p style={MAP_STYLES.note}>
				{pointCapLine(sample.mode, props.pointCap)} · {knnSourceLine(sample, props.backend)} · {DISTANCE_CAVEAT}
			</p>
			{(props.notes ?? []).map((line) => (
				<p key={line} style={MAP_STYLES.note}>
					{line}
				</p>
			))}
			{props.scopeRetry ? (
				<p style={MAP_STYLES.note}>
					<button type="button" style={MAP_STYLES.button} data-scope-retry="" onClick={props.scopeRetry.onClick}>
						{props.scopeRetry.label}
					</button>
				</p>
			) : null}
		</section>
	);
}

export default Legend;
