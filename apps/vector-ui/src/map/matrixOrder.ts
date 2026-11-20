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
// MAP - THE SIMILARITY MATRIX'S ORDER, RANGE AND ROWS (pure)
// =============================================================================
//
// The Selection tab's matrix compares the selected chunks pairwise by the
// store's metric (`similarity_matrix`, contract section 4.4-E). What is sent
// is the selection's keys, each once, never sample indices: the node
// resolves them from its cached sample or the store, so a re-drawn sample
// cannot shift the matrix. Rows and columns are then ordered here by
// nearest-neighbour chaining (start at the most similar pair, always step to
// the most similar chunk not placed yet), which puts similar chunks next to
// each other without any clustering call.
// =============================================================================

import type { ExportCell, IExportRows, ISimilarityMatrixInput, IVectorLimits, VectorKey } from '../contract/types';
import { MATRIX_UNSUPPORTED, matrixTooFew, matrixTooMany } from './reviewWording';

/**
 * Whether the node has the tool (it reports `limits.matrix_keys_max`).
 *
 * @param limits - The dialect's limits.
 * @returns True when the node computes matrices.
 */
export function matrixAvailable(limits: IVectorLimits): boolean {
	return typeof limits.matrix_keys_max === 'number' && limits.matrix_keys_max >= 2;
}

/**
 * The `similarity_matrix` input for a selection: its keys, each once, in
 * selection order; or why there is none.
 *
 * @param keys - The selection's keys.
 * @param limits - The dialect's limits.
 * @returns The input, or the sentence that stops it.
 */
export function matrixInput(keys: readonly VectorKey[], limits: IVectorLimits): { input: ISimilarityMatrixInput } | { blocker: string } {
	if (!matrixAvailable(limits)) return { blocker: MATRIX_UNSUPPORTED };
	const max = limits.matrix_keys_max as number;
	const seen = new Set<string>();
	const unique: VectorKey[] = [];
	for (const key of keys) {
		const id = `${key[0]}#${key[1]}`;
		if (seen.has(id)) continue;
		seen.add(id);
		unique.push([key[0], key[1]]);
	}
	if (unique.length < 2) return { blocker: matrixTooFew(max) };
	if (unique.length > max) return { blocker: matrixTooMany(max, unique.length) };
	return { input: { keys: unique } };
}

/** A cell of a similarity matrix: null where the node could not compute one (a non-finite value). */
export type MatrixCell = number | null;

/**
 * A cell's value when it is a finite number, else null.
 *
 * @param value - The cell.
 * @returns The value, or null.
 */
export function cellValue(value: MatrixCell | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Nearest-neighbour chaining: start at the first point of the most similar
 * pair, then step each time to the most similar point not placed yet (ties
 * to the lower index). A missing cell is the least similar.
 *
 * @param matrix - n × n similarities.
 * @returns The order, a permutation of 0..n-1.
 */
export function chainOrder(matrix: ReadonlyArray<ReadonlyArray<MatrixCell>>): number[] {
	const n = matrix.length;
	if (n === 0) return [];
	let start = 0;
	let best = -Infinity;
	for (let i = 0; i < n; i += 1) {
		const row = matrix[i] as ReadonlyArray<MatrixCell>;
		for (let j = i + 1; j < n; j += 1) {
			const v = cellValue(row[j]) ?? -Infinity;
			if (v > best) {
				best = v;
				start = i;
			}
		}
	}
	const placed = new Uint8Array(n);
	const order = [start];
	placed[start] = 1;
	let current = start;
	while (order.length < n) {
		const row = matrix[current] as ReadonlyArray<MatrixCell>;
		let next = -1;
		let nextValue = -Infinity;
		for (let j = 0; j < n; j += 1) {
			if (placed[j]) continue;
			const v = cellValue(row[j]) ?? -Infinity;
			if (next === -1 || v > nextValue) {
				next = j;
				nextValue = v;
			}
		}
		placed[next] = 1;
		order.push(next);
		current = next;
	}
	return order;
}

/**
 * Put the keys and the matrix in an order.
 *
 * @param m - The keys and matrix.
 * @param order - A permutation.
 * @returns The keys and matrix in that order.
 */
export function reorder(m: { keys: readonly VectorKey[]; matrix: ReadonlyArray<ReadonlyArray<MatrixCell>> }, order: readonly number[]): { keys: VectorKey[]; matrix: MatrixCell[][] } {
	return {
		keys: order.map((i) => m.keys[i] as VectorKey),
		matrix: order.map((i) => order.map((j) => cellValue((m.matrix[i] as ReadonlyArray<MatrixCell>)[j]))),
	};
}

/**
 * The lowest and highest similarity between two different chunks (the
 * diagonal and missing cells left out).
 *
 * @param matrix - n × n similarities.
 * @returns The range (0 to 1 with fewer than two chunks).
 */
export function matrixRange(matrix: ReadonlyArray<ReadonlyArray<MatrixCell>>): { min: number; max: number } {
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < matrix.length; i += 1) {
		const row = matrix[i] as ReadonlyArray<MatrixCell>;
		for (let j = 0; j < row.length; j += 1) {
			if (i === j) continue;
			const v = cellValue(row[j]);
			if (v === null) continue;
			if (v < min) min = v;
			if (v > max) max = v;
		}
	}
	return Number.isFinite(min) ? { min, max } : { min: 0, max: 1 };
}

/**
 * How dark a cell is: its place in the range, 0 (lightest) to 1 (darkest),
 * values above the range (the diagonal) at 1, a missing cell at 0.
 *
 * @param value - A similarity, or null.
 * @param range - The matrix's range.
 * @returns 0 to 1.
 */
export function shadeOf(value: MatrixCell, range: { min: number; max: number }): number {
	if (value === null || !Number.isFinite(value)) return 0;
	if (range.max <= range.min) return value >= range.max ? 1 : 0;
	return Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
}

/**
 * The heatmap cell under a point of its canvas: [row, column], or null
 * outside the grid. A gap belongs to the cell before it, so a pointer
 * between two 3 px cells still picks one.
 *
 * @param x - Pixels from the canvas's left edge (CSS pixels).
 * @param y - Pixels from its top edge.
 * @param n - Keys (rows and columns).
 * @param size - A cell's side.
 * @param gap - The gap between cells.
 * @returns The cell, or null.
 */
export function heatCellAt(x: number, y: number, n: number, size: number, gap: number): [number, number] | null {
	const pitch = size + gap;
	const side = n * pitch - gap;
	if (!(x >= 0 && y >= 0 && x < side && y < side)) return null;
	return [Math.min(n - 1, Math.floor(y / pitch)), Math.min(n - 1, Math.floor(x / pitch))];
}

/**
 * The matrix as export rows: one per key with its objectId, chunk and
 * words, then a column per key (column names made unique); a missing cell is
 * empty.
 *
 * @param keys - The keys, in display order.
 * @param matrix - The matrix in that order.
 * @param labelOf - Words for a key.
 * @returns The rows.
 */
export function matrixRows(keys: readonly VectorKey[], matrix: ReadonlyArray<ReadonlyArray<MatrixCell>>, labelOf: (key: VectorKey) => string): IExportRows {
	const used = new Map<string, number>();
	const names = keys.map((key) => {
		const base = labelOf(key);
		const seen = (used.get(base) ?? 0) + 1;
		used.set(base, seen);
		return seen === 1 ? base : `${base} (${seen})`;
	});
	const columns = ['objectId', 'chunkId', 'label', ...names];
	const rows = keys.map((key, i) => {
		const row: Record<string, ExportCell> = { objectId: key[0], chunkId: key[1], label: labelOf(key) };
		names.forEach((name, j) => {
			row[name] = cellValue((matrix[i] as ReadonlyArray<MatrixCell>)[j]);
		});
		return row;
	});
	return { columns, rows };
}
