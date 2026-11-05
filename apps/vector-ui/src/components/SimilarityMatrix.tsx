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
// VECTOR-UI — SimilarityMatrix (the map's Selection tab)
// =============================================================================
//
// The pairwise similarities of 2 to `limits.matrix_keys_max` selected chunks
// as a heatmap with a table alternative, rows and columns ordered by
// nearest-neighbour chaining, a legend in words, Export CSV and Show pair.
// Up to 20 x 20 the heatmap's cells are elements with their values printed;
// above that it is one canvas (10,000 cells at the cap would be 20,000
// elements), with the hovered pair in its title and the picked pair outlined
// over it, so a pick redraws no cell. The table shows 20 rows at a time.
// Calls `similarity_matrix` with the selection's keys (never sample indices,
// so a re-drawn sample cannot shift the matrix) through map/calls.ts; the
// answer carries scalars only. A newer selection replaces an older answer.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { IRoleChannel } from 'shared/explorer';
import type { IExportItem, IVectorLimits, MatrixSource, SimilarityMatrixProps, VectorKey, VectorMetric } from '../contract/types';
import { callSimilarityMatrix } from '../map/calls';
import { cellValue, chainOrder, heatCellAt, matrixInput, matrixRange, matrixRows, reorder, shadeOf } from '../map/matrixOrder';
import type { MatrixCell } from '../map/matrixOrder';
import { MATRIX_BUSY, MATRIX_NO_CHANNEL, PICK_A_PAIR, matrixCaption, matrixFailure, matrixLegend, matrixNotFound, matrixSourceLine, matrixTableRowsLine, selectedPairLine } from '../map/reviewWording';
import { MAP_STYLES } from '../map/styles';
import { readPalette } from '../map/tokens';

export type { SimilarityMatrixProps };

/** Largest matrix whose values are printed in its cells (drawn as elements; a larger one is one canvas). */
export const IN_CELL_MAX = 20;

/** Rows of the table alternative shown at a time. */
export const TABLE_ROWS_PER_PAGE = 20;

/** The gap between heatmap cells, in CSS pixels. */
const HEAT_GAP = 1;

/** The lightest and darkest shade of the ramp (the legend's ends). */
const SHADE_MIN = 0.06;
const SHADE_SPAN = 0.84;

/** What the panel shows. */
export type MatrixState = { kind: 'blocked'; message: string } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'ok'; keys: VectorKey[]; matrix: MatrixCell[][]; metric: VectorMetric; source: MatrixSource; notFound: VectorKey[]; dp?: number };

/**
 * A cell's words: its value at `dp` decimals, or a dash where the node could not compute it.
 *
 * @param value - The cell.
 * @param dp - Decimals.
 * @returns The words.
 */
export function cellText(value: MatrixCell | undefined, dp: number): string {
	const v = cellValue(value);
	return v === null ? '–' : v.toFixed(dp);
}

/**
 * Compute a selection's matrix on the store node and order it.
 *
 * @param channel - The channel that reaches the store node.
 * @param storeNode - The store node id.
 * @param keys - The selection's keys.
 * @param limits - The dialect's limits.
 * @returns The ordered matrix, the reason none was asked for, or the failure.
 */
export async function loadMatrix(channel: Pick<IRoleChannel, 'invoke'>, storeNode: string, keys: readonly VectorKey[], limits: IVectorLimits): Promise<MatrixState> {
	const plan = matrixInput(keys, limits);
	if ('blocker' in plan) return { kind: 'blocked', message: plan.blocker };
	const answer = await callSimilarityMatrix(channel, plan.input, { nodeId: storeNode });
	if (!answer.ok) return { kind: 'error', message: matrixFailure(answer.code, answer.message, limits.matrix_keys_max) };
	const result = answer.value;
	// The node answers null for a cell it could not compute (a non-finite value).
	const matrix = result.matrix as ReadonlyArray<ReadonlyArray<MatrixCell>>;
	const ordered = reorder({ keys: result.keys, matrix }, chainOrder(matrix));
	return { kind: 'ok', keys: ordered.keys, matrix: ordered.matrix, metric: result.metric, source: result.source, notFound: result.not_found, dp: result.dp };
}

/**
 * The export entry of a matrix (rows built when it is chosen).
 *
 * @param keys - The keys, in display order.
 * @param matrix - The matrix in that order.
 * @param labelOf - Words for a key.
 * @returns The item.
 */
export function matrixExportItem(keys: readonly VectorKey[], matrix: ReadonlyArray<ReadonlyArray<MatrixCell>>, labelOf: (key: VectorKey) => string): IExportItem {
	return { id: 'map-matrix', label: `Similarity matrix (${keys.length} × ${keys.length})`, kind: 'matrix', disabled: null, rows: () => matrixRows(keys, matrix, labelOf) };
}

/** What the panel's body is drawn from. */
export interface MatrixBodyProps {
	state: MatrixState;
	labelOf(key: VectorKey): string;
	/** The picked pair (display indices), or null. */
	selected: readonly [number, number] | null;
	showTable: boolean;
	canShowPair: boolean;
	canExport: boolean;
	onSelectPair(i: number, j: number): void;
	onToggleTable(): void;
	onShowPair(): void;
	onExport(): void;
	/** The table's page (from 0; clamped to the last); 0 when absent. */
	tablePage?: number;
	/** Turn the table's page. */
	onTablePage?(page: number): void;
}

/** What paintHeatmap draws on (a 2D canvas context, or a recording stand-in in the tests). */
export interface IHeatmapContext {
	fillStyle: string | CanvasGradient | CanvasPattern;
	globalAlpha: number;
	clearRect(x: number, y: number, w: number, h: number): void;
	fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * Paint a heatmap: every cell on the surface colour, then the ramp colour
 * over it at the cell's shade (lighter: less similar), as the element
 * cells do; a missing cell stays on the surface. Two fill colours in all,
 * so 10,000 cells take a few milliseconds.
 *
 * @param ctx - The context, in CSS pixels.
 * @param matrix - The matrix, in display order.
 * @param range - The off-diagonal range (matrixRange).
 * @param size - A cell's side.
 * @param gap - The gap between cells.
 * @param colours - The surface and the ramp colour.
 */
export function paintHeatmap(ctx: IHeatmapContext, matrix: ReadonlyArray<ReadonlyArray<MatrixCell>>, range: { min: number; max: number }, size: number, gap: number, colours: { surface: string; ramp: string }): void {
	const n = matrix.length;
	const pitch = size + gap;
	ctx.globalAlpha = 1;
	ctx.clearRect(0, 0, n * pitch, n * pitch);
	ctx.fillStyle = colours.surface;
	for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) ctx.fillRect(j * pitch, i * pitch, size, size);
	ctx.fillStyle = colours.ramp;
	for (let i = 0; i < n; i += 1) {
		const row = matrix[i] as ReadonlyArray<MatrixCell>;
		for (let j = 0; j < n; j += 1) {
			const value = cellValue(row[j]);
			if (value === null) continue;
			ctx.globalAlpha = Math.round((SHADE_MIN + SHADE_SPAN * shadeOf(value, range)) * 1000) / 1000;
			ctx.fillRect(j * pitch, i * pitch, size, size);
		}
	}
	ctx.globalAlpha = 1;
}

/**
 * A counter that moves when the shell switches theme (it writes tokens onto
 * the root element), so the canvas re-reads its colours.
 *
 * @returns The counter.
 */
function useThemeTick(): number {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
		const observer = new MutationObserver(() => setTick((t) => t + 1));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
		return () => observer.disconnect();
	}, []);
	return tick;
}

/** What the canvas heatmap is drawn from. */
interface HeatmapCanvasProps {
	matrix: MatrixCell[][];
	labels: readonly string[];
	dp: number;
	size: number;
	selected: readonly [number, number] | null;
	onSelectPair(i: number, j: number): void;
}

/**
 * The heatmap of a large matrix on one canvas. The cells are painted when
 * the matrix, the cell size or the theme changes, never on a pick: the
 * picked pair is two outlines laid over the canvas. The hovered pair goes
 * into the canvas's title without a render.
 *
 * @param props - The matrix, its labels and the pick.
 * @returns The canvas with its outlines.
 */
function HeatmapCanvas(props: HeatmapCanvasProps): React.ReactElement {
	const { matrix, size, selected } = props;
	const ref = useRef<HTMLCanvasElement | null>(null);
	const theme = useThemeTick();
	const n = matrix.length;
	const pitch = size + HEAT_GAP;
	const side = n * pitch - HEAT_GAP;

	useEffect(() => {
		const canvas = ref.current;
		const ctx = canvas?.getContext('2d') ?? null;
		if (!canvas || !ctx) return;
		const ratio = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
		canvas.width = Math.round(side * ratio);
		canvas.height = Math.round(side * ratio);
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		const style = getComputedStyle(canvas);
		const palette = readPalette((token) => style.getPropertyValue(token));
		paintHeatmap(ctx, matrix, matrixRange(matrix), size, HEAT_GAP, { surface: palette.surfaces.default, ramp: palette.chart[0] as string });
	}, [matrix, size, side, theme]);

	const cellOf = (event: React.MouseEvent<HTMLCanvasElement>): [number, number] | null => {
		const box = event.currentTarget.getBoundingClientRect();
		return heatCellAt(event.clientX - box.left, event.clientY - box.top, n, size, HEAT_GAP);
	};
	const outlines: Array<readonly [number, number]> = selected === null ? [] : selected[0] === selected[1] ? [selected] : [selected, [selected[1], selected[0]]];
	return (
		<div style={{ position: 'relative', width: side, height: side }}>
			<canvas
				ref={ref}
				aria-hidden="true"
				data-matrix-size={n}
				style={{ display: 'block', width: side, height: side, cursor: 'pointer' }}
				onMouseMove={(event) => {
					const cell = cellOf(event);
					event.currentTarget.title = cell === null ? '' : `${props.labels[cell[0]]} ↔ ${props.labels[cell[1]]}: ${cellText((matrix[cell[0]] as MatrixCell[])[cell[1]], props.dp)}`;
				}}
				onMouseLeave={(event) => {
					event.currentTarget.title = '';
				}}
				onClick={(event) => {
					const cell = cellOf(event);
					if (cell !== null) props.onSelectPair(cell[0], cell[1]);
				}}
			/>
			{outlines.map(([i, j]) => (
				<div key={`${i}-${j}`} aria-hidden="true" data-picked={`${i}-${j}`} style={{ position: 'absolute', left: j * pitch, top: i * pitch, width: size, height: size, boxShadow: '0 0 0 2px var(--rr-text-primary)', pointerEvents: 'none' }} />
			))}
		</div>
	);
}

/**
 * The heatmap: one cell per pair, darker for more similar, the value on
 * hover and (up to 20 x 20, as elements) in the cell; larger matrices on one
 * canvas. Hidden from screen readers: the table is their view.
 *
 * @param props - The body's props.
 * @param ok - The matrix.
 * @returns The grid.
 */
function heatmap(props: MatrixBodyProps, ok: Extract<MatrixState, { kind: 'ok' }>): React.ReactElement {
	const n = ok.keys.length;
	const dp = ok.dp ?? 2;
	const size = n <= IN_CELL_MAX ? 28 : Math.max(3, Math.floor(300 / n));
	const labels = ok.keys.map((key) => props.labelOf(key));
	if (n > IN_CELL_MAX) {
		return (
			<div style={{ overflow: 'auto', maxWidth: '100%', margin: '6px 0' }}>
				<HeatmapCanvas matrix={ok.matrix} labels={labels} dp={dp} size={size} selected={props.selected} onSelectPair={props.onSelectPair} />
			</div>
		);
	}
	const range = matrixRange(ok.matrix);
	const cells: React.ReactElement[] = [];
	for (let i = 0; i < n; i += 1) {
		const row = ok.matrix[i] as MatrixCell[];
		for (let j = 0; j < n; j += 1) {
			const value = cellValue(row[j]);
			const words = cellText(value, dp);
			const picked = props.selected !== null && ((props.selected[0] === i && props.selected[1] === j) || (props.selected[0] === j && props.selected[1] === i));
			cells.push(
				<div key={`${i}-${j}`} data-cell={`${i}-${j}`} title={`${labels[i]} ↔ ${labels[j]}: ${words}`} onClick={() => props.onSelectPair(i, j)} style={{ position: 'relative', width: size, height: size, background: 'var(--rr-bg-default)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: picked ? 'inset 0 0 0 2px var(--rr-text-primary)' : undefined }}>
					{value === null ? null : <div style={{ position: 'absolute', inset: 0, background: 'var(--rr-chart-blue)', opacity: SHADE_MIN + SHADE_SPAN * shadeOf(value, range) }} />}
					<span style={{ position: 'relative', fontSize: 8.5, lineHeight: 1.2, color: 'var(--rr-text-primary)', background: 'var(--rr-bg-paper)', borderRadius: 2, padding: '0 1px' }}>{words}</span>
				</div>
			);
		}
	}
	return (
		<div style={{ overflow: 'auto', maxWidth: '100%', margin: '6px 0' }}>
			<div aria-hidden="true" data-matrix-size={n} style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, ${size}px)`, gap: 1, width: 'max-content' }}>
				{cells}
			</div>
		</div>
	);
}

/**
 * The table alternative: a header per key, each value a button that picks
 * its pair; 20 rows at a time (every column), turned with Previous and Next
 * rows, so the cap's 10,000 values are never all on the page at once.
 *
 * @param props - The body's props.
 * @param ok - The matrix.
 * @returns The table.
 */
function table(props: MatrixBodyProps, ok: Extract<MatrixState, { kind: 'ok' }>): React.ReactElement {
	const dp = ok.dp ?? 2;
	const labels = ok.keys.map((key) => props.labelOf(key));
	const n = ok.matrix.length;
	const pages = Math.max(1, Math.ceil(n / TABLE_ROWS_PER_PAGE));
	const page = Math.min(pages - 1, Math.max(0, Math.floor(props.tablePage ?? 0)));
	const first = page * TABLE_ROWS_PER_PAGE;
	const rows = ok.matrix.slice(first, first + TABLE_ROWS_PER_PAGE);
	return (
		<>
			{pages > 1 ? (
				<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, margin: '4px 0' }}>
					<button type="button" style={MAP_STYLES.button} disabled={page === 0} onClick={() => props.onTablePage?.(page - 1)}>
						Previous rows
					</button>
					<button type="button" style={MAP_STYLES.button} disabled={page === pages - 1} onClick={() => props.onTablePage?.(page + 1)}>
						Next rows
					</button>
					<span style={MAP_STYLES.small}>{matrixTableRowsLine(first + 1, first + rows.length, n)}</span>
				</div>
			) : null}
			<div style={{ overflow: 'auto', maxWidth: '100%', maxHeight: 320 }}>
				<table style={MAP_STYLES.table} aria-label="Similarity matrix as a table">
					<thead>
						<tr>
							<td style={MAP_STYLES.th} />
							{labels.map((label, j) => (
								<th key={j} scope="col" style={MAP_STYLES.th}>
									{label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, r) => {
							const i = first + r;
							return (
								<tr key={i}>
									<th scope="row" style={{ ...MAP_STYLES.td, fontWeight: 700, textAlign: 'left' }}>
										{labels[i]}
									</th>
									{row.map((value, j) => {
										const picked = props.selected !== null && props.selected[0] === i && props.selected[1] === j;
										return (
											<td key={j} style={MAP_STYLES.td}>
												<button type="button" style={MAP_STYLES.linkButton} aria-pressed={picked} aria-label={`${labels[i]} ↔ ${labels[j]}: ${cellText(value, dp)}`} onClick={() => props.onSelectPair(i, j)}>
													{cellText(value, dp)}
												</button>
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</>
	);
}

/**
 * The panel's body: a plain function of its state (no hooks), so the tests
 * can call it and press its buttons.
 *
 * @param props - The state, the picked pair and the handlers.
 * @returns The body.
 */
export function MatrixBody(props: MatrixBodyProps): React.ReactElement {
	const { state } = props;
	if (state.kind !== 'ok') {
		return (
			<section aria-label="Similarity matrix" data-component="SimilarityMatrix" data-state={state.kind}>
				{state.kind === 'busy' ? (
					<p style={MAP_STYLES.note} role="status">
						{MATRIX_BUSY}
					</p>
				) : (
					<p style={MAP_STYLES.note}>{state.message}</p>
				)}
			</section>
		);
	}
	const dp = state.dp ?? 2;
	const range = matrixRange(state.matrix);
	const missing = matrixNotFound(state.notFound.map((key) => props.labelOf(key)));
	const pair = props.selected;
	return (
		<section aria-label="Similarity matrix" data-component="SimilarityMatrix" data-state="ok" data-n={state.keys.length}>
			<h4 style={{ ...MAP_STYLES.heading, fontSize: 12, marginTop: 10 }}>Similarity matrix</h4>
			<p style={MAP_STYLES.note}>{matrixCaption(state.keys.length, state.metric)}</p>
			<p style={MAP_STYLES.note}>{matrixSourceLine(state.source)}</p>
			{missing ? <p style={MAP_STYLES.note}>{missing}</p> : null}
			{heatmap(props, state)}
			<p style={MAP_STYLES.note}>{matrixLegend(range.min, range.max, dp)}</p>
			<p style={MAP_STYLES.small} role="status">
				{pair ? selectedPairLine(props.labelOf(state.keys[pair[0]] as VectorKey), props.labelOf(state.keys[pair[1]] as VectorKey), cellText((state.matrix[pair[0]] as MatrixCell[])[pair[1]], dp)) : PICK_A_PAIR}
			</p>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' }}>
				{props.canShowPair ? (
					<button type="button" style={MAP_STYLES.button} disabled={pair === null} onClick={() => props.onShowPair()}>
						Show pair
					</button>
				) : null}
				{props.canExport ? (
					<button type="button" style={MAP_STYLES.button} onClick={() => props.onExport()}>
						Export CSV
					</button>
				) : null}
				<button type="button" style={MAP_STYLES.button} aria-expanded={props.showTable} onClick={() => props.onToggleTable()}>
					{props.showTable ? 'Hide the table' : 'Show as a table'}
				</button>
			</div>
			{props.showTable ? table(props, state) : null}
		</section>
	);
}

/**
 * The similarity matrix of the selection.
 *
 * @param props - The frozen props: the selection's keys, limits, the channel, the store node, words for a key, the pair and export handlers.
 * @returns The panel.
 */
export function SimilarityMatrix(props: SimilarityMatrixProps): React.ReactElement {
	const { keys, limits, channel, storeNode } = props;
	const plan = matrixInput(keys, limits);
	const signature = JSON.stringify('input' in plan ? plan.input.keys : plan.blocker);
	const [state, setState] = useState<MatrixState>({ kind: 'busy' });
	const [selected, setSelected] = useState<readonly [number, number] | null>(null);
	const [showTable, setShowTable] = useState(false);
	const [tablePage, setTablePage] = useState(0);

	useEffect(() => {
		if (!('input' in plan) || channel === null) return;
		let live = true;
		setState({ kind: 'busy' });
		setSelected(null);
		setTablePage(0);
		void loadMatrix(channel, storeNode, keys, limits).then((next) => {
			if (live) setState(next);
		});
		return () => {
			live = false;
		};
		// The keys are compared by value (signature); a new array of the same keys asks nothing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [signature, channel, storeNode, limits.matrix_keys_max]);

	const shown: MatrixState = 'blocker' in plan ? { kind: 'blocked', message: plan.blocker } : channel === null ? { kind: 'blocked', message: MATRIX_NO_CHANNEL } : state;
	return (
		<MatrixBody
			state={shown}
			labelOf={props.labelOf}
			selected={selected}
			showTable={showTable}
			canShowPair={props.onShowPair !== undefined}
			canExport={props.onExport !== undefined}
			onSelectPair={(i, j) => setSelected([i, j])}
			onToggleTable={() => setShowTable((v) => !v)}
			tablePage={tablePage}
			onTablePage={setTablePage}
			onShowPair={() => {
				if (shown.kind !== 'ok' || selected === null) return;
				props.onShowPair?.(shown.keys[selected[0]] as VectorKey, shown.keys[selected[1]] as VectorKey);
			}}
			onExport={() => {
				if (shown.kind !== 'ok') return;
				props.onExport?.(matrixExportItem(shown.keys, shown.matrix, props.labelOf));
			}}
		/>
	);
}

export default SimilarityMatrix;
