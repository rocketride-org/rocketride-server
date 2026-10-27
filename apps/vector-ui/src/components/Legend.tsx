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
// (what it is drawn from, the documents and the seed) and the point cap of the
// mode, who computed the neighbour graph ("neighbour graph computed by Qdrant"
// when the store did it natively) and the caveat that 2D distances are
// approximate while ranks and scores are exact. Coloured by cluster it lists
// the largest groups and says how many more the Clusters tab lists. Under the
// colours, a row of the marks drawn now, each a small picture in the canvas's
// own colours with its words: similarity edges, the selected point's links,
// outlier rings, the query's star and rays, near-duplicate pairs; a mark not
// drawn is not listed. The view adds its lines (what a cluster is, the edges
// drawn, how the sample's listing ended, the scope, an isolation) as notes,
// and the draw again when the store refused to draw the sample for the
// console's scope. Its height is capped (map/styles.ts LEGEND_MAX_HEIGHT):
// past it the legend scrolls inside itself (then it is a tab stop, so a
// keyboard reaches what is below), so its notes never take the map's height.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { LegendProps as ContractLegendProps } from '../contract/types';
import type { IColouring, MapColourBy } from '../map/colours';
import { MAP_STYLES } from '../map/styles';
import { ACCENT_TOKEN, OUTLINE_TOKEN } from '../map/tokens';
import { DISTANCE_CAVEAT, biasedNote, knnSourceLine, num, pointCapLine, sampleLabel } from '../map/wording';

/** Groups listed by name when coloured by cluster (the Clusters tab lists every one). */
export const LEGEND_CLUSTERS = 12;

/** The marks the map draws now, for the glyph row (a mark absent or 0 is not drawn, so not listed). */
export interface ILegendMarks {
	/** The edge colours (weakest and strongest bucket) while similarity edges are drawn. */
	edges?: { weakest: string; strongest: string } | null;
	/** The selected point's links to its nearest chunks are drawn. */
	links?: boolean;
	/** Outlier rings drawn. */
	outliers?: number;
	/** The query's star is drawn: its true top N, and the rays drawn (a result not placed on the map has none). */
	query?: { top: number; drawn: number } | null;
	/** Near-duplicate pairs drawn. */
	duplicates?: number;
	/** A shown duplicate group's rings, labelled with this scale (reviewWording pairScale), or null. */
	rings?: { scale: string } | null;
}

/** Legend props: the frozen ones (Colour by widened) plus what the map computed. */
export interface LegendProps extends Omit<ContractLegendProps, 'colourBy'> {
	colourBy: MapColourBy;
	/** The current colouring (legend rows, ramp, note), when there is one. */
	colouring?: IColouring | null;
	/** Extra lines (query placement, layout notes). */
	notes?: readonly string[];
	/** Offered under the lines when the store refused to draw the sample for the console's scope. */
	scopeRetry?: { label: string; onClick(): void } | null;
	/** The marks drawn now (the glyph row). */
	marks?: ILegendMarks | null;
}

/** The marks' list keeps two lines of 18 px. */
export const MARK_ROWS_HEIGHT = 36;

/** The canvas's colours, as the glyphs draw them. */
const ACCENT = `var(${ACCENT_TOKEN})`;
const OUTLINE = `var(${OUTLINE_TOKEN})`;
const SURFACE = 'var(--rr-bg-default)';

/**
 * A mark's picture: a small tile of the map's surface with the mark drawn as the canvas draws it.
 *
 * @param children - SVG shapes in a 22 x 12 box.
 * @returns The glyph (hidden from assistive tech: the words carry it).
 */
function glyph(children: React.ReactNode): React.ReactElement {
	return (
		<svg aria-hidden="true" width={22} height={12} viewBox="0 0 22 12" style={{ flex: 'none', marginRight: 6, verticalAlign: 'middle' }}>
			<rect x={0} y={0} width={22} height={12} rx={2} style={{ fill: SURFACE }} />
			{children}
		</svg>
	);
}

/** A five-pointed star's points around (cx, cy). */
function starPoints(cx: number, cy: number, outer: number, inner: number): string {
	return Array.from({ length: 10 }, (_, v) => {
		const angle = -Math.PI / 2 + (v * Math.PI) / 5;
		const r = v % 2 === 0 ? outer : inner;
		return `${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`;
	}).join(' ');
}

/**
 * The glyph row: one entry per mark drawn now.
 *
 * @param marks - What the map draws.
 * @returns The entries.
 */
export function markRows(marks: ILegendMarks | null | undefined): Array<{ key: string; picture: React.ReactElement; words: string }> {
	if (!marks) return [];
	const rows: Array<{ key: string; picture: React.ReactElement; words: string }> = [];
	if (marks.edges) {
		rows.push({
			key: 'edges',
			words: 'similarity edge (fainter: less similar)',
			picture: glyph(
				<>
					<line x1={2} y1={6} x2={10} y2={6} style={{ stroke: marks.edges.weakest, strokeWidth: 1.5 }} />
					<line x1={12} y1={6} x2={20} y2={6} style={{ stroke: marks.edges.strongest, strokeWidth: 1.5 }} />
				</>,
			),
		});
	}
	if (marks.links) {
		rows.push({
			key: 'links',
			words: "selected point's nearest chunks",
			picture: glyph(
				<>
					<line x1={7} y1={6} x2={20} y2={6} style={{ stroke: ACCENT, strokeWidth: 1.5 }} />
					<circle cx={5} cy={6} r={3} style={{ fill: 'none', stroke: ACCENT, strokeWidth: 1.5 }} />
				</>,
			),
		});
	}
	if (marks.outliers && marks.outliers > 0) {
		rows.push({
			key: 'outliers',
			words: `outlier (${num(marks.outliers)})`,
			picture: glyph(
				<>
					<circle cx={11} cy={6} r={4} style={{ fill: 'none', stroke: SURFACE, strokeWidth: 3 }} />
					<circle cx={11} cy={6} r={4} style={{ fill: 'none', stroke: OUTLINE, strokeWidth: 1.5 }} />
				</>,
			),
		});
	}
	if (marks.query) {
		const { top, drawn } = marks.query;
		rows.push({
			key: 'query',
			words: drawn < top ? `query, rays to ${num(drawn)} of its true top ${num(top)}` : `query, rays to its true top ${num(top)}`,
			picture: glyph(
				<>
					<line x1={8} y1={6} x2={21} y2={6} style={{ stroke: ACCENT, strokeWidth: 1.25 }} />
					<polygon points={starPoints(6, 6, 5, 2.2)} style={{ fill: ACCENT, stroke: SURFACE, strokeWidth: 1 }} />
				</>,
			),
		});
	}
	if (marks.duplicates && marks.duplicates > 0) {
		rows.push({
			key: 'duplicates',
			words: `near-duplicate pair (${num(marks.duplicates)})`,
			picture: glyph(<line x1={3} y1={6} x2={19} y2={6} style={{ stroke: OUTLINE, strokeWidth: 1.5, strokeDasharray: '4 3' }} />),
		});
	}
	if (marks.rings) {
		rows.push({
			key: 'rings',
			words: `shown duplicate group: each pair's similarity (${marks.rings.scale})`,
			picture: glyph(
				<>
					<circle cx={11} cy={6} r={4} style={{ fill: 'none', stroke: SURFACE, strokeWidth: 3 }} />
					<circle cx={11} cy={6} r={4} style={{ fill: 'none', stroke: OUTLINE, strokeWidth: 1.5, strokeDasharray: '3 2' }} />
				</>,
			),
		});
	}
	return rows;
}

/**
 * Whether a box's content runs past its height (a pixel of rounding is not scrolling).
 *
 * @param scrollHeight - Its content's height.
 * @param clientHeight - Its own height.
 * @returns True when it scrolls.
 */
export function scrollsInside(scrollHeight: number, clientHeight: number): boolean {
	return scrollHeight - clientHeight > 1;
}

/**
 * The map legend.
 *
 * @param props - Sample, colour mode, point cap, backend, colouring.
 * @returns The legend.
 */
export function Legend(props: LegendProps): React.ReactElement {
	const section = useRef<HTMLElement>(null);
	// A tab stop only while it scrolls past its cap (a keyboard must reach what is below); measured when what it
	// says changes and when its box changes size.
	const [scrolls, setScrolls] = useState(false);
	useEffect(() => {
		const el = section.current;
		if (el) setScrolls(scrollsInside(el.scrollHeight, el.clientHeight));
	}, [props.sample, props.colourBy, props.colouring, props.notes, props.marks, props.scopeRetry]);
	useEffect(() => {
		const el = section.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => setScrolls(scrollsInside(el.scrollHeight, el.clientHeight)));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const sample = props.sample.result;
	const colouring = props.colouring ?? null;
	const bias = biasedNote(sample);
	const rampStyle: React.CSSProperties | null = colouring?.ramp ? { height: 10, borderRadius: 3, background: `linear-gradient(to right, ${colouring.ramp.stops.join(', ')})`, margin: '4px 0' } : null;
	// Coloured by cluster: the largest groups by name, then the noise row; the rest are counted.
	const all = colouring?.legend ?? [];
	const groups = props.colourBy === 'cluster' ? all.filter((e) => e.key !== 'noise') : all;
	const rows = props.colourBy === 'cluster' ? [...groups.slice(0, LEGEND_CLUSTERS), ...all.filter((e) => e.key === 'noise')] : all;
	const more = props.colourBy === 'cluster' ? Math.max(0, groups.length - LEGEND_CLUSTERS) : 0;
	const marks = markRows(props.marks);
	const docs = sample.of.documents === null || sample.of.documents === undefined ? '—' : num(sample.of.documents);
	return (
		<section ref={section} aria-label="Map legend" tabIndex={scrolls ? 0 : undefined} style={MAP_STYLES.legend} data-knn-source={sample.knn_source} data-colour-by={props.colourBy}>
			<p style={MAP_STYLES.note}>
				{sampleLabel(sample)} · {docs} docs · seed {props.sample.seed}
			</p>
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
			{/* Two lines kept whatever is marked (all six marks fit in two at a legend 750 px wide or more, measured in
			    Chrome), so selecting a point or showing a group does not resize the map. */}
			<div style={{ minHeight: MARK_ROWS_HEIGHT, margin: '4px 0' }} data-legend-marks={marks.map((m) => m.key).join(' ')}>
				{marks.length > 0 ? (
					<ul aria-label="Marks" style={{ ...MAP_STYLES.list, display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
						{marks.map((mark) => (
							<li key={mark.key} style={{ ...MAP_STYLES.small, display: 'inline-flex', alignItems: 'center' }}>
								{mark.picture}
								<span>{mark.words}</span>
							</li>
						))}
					</ul>
				) : null}
			</div>
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
