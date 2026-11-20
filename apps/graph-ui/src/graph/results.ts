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
// GRAPH - RESULT ANALYSIS (what a `read_query` answer holds, and which tab opens)
// =============================================================================
//
// Rows are positional arrays, so a result that names the same column twice keeps
// both. The grid, however, keys its cells by field name, so every column gets a
// stable GENERATED key (`c0`, `c1`, ...) and the real name is only its title.
// Nothing here ever derives a key from a column name.
// =============================================================================

import { MAX_DEPTH, MAX_VISITS, countUnsafeNumbers, hasKindKey, isGraphNode, isGraphPath, isGraphRelationship, isPlainObject, isTagged, toJsonText } from './values';
import type { GraphId, GraphNode, GraphRelationship, ReadQueryResult } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Every distinct node and relationship found in a result, in first-seen order. */
export interface IEntities {
	nodes: Map<GraphId, GraphNode>;
	relationships: Map<GraphId, GraphRelationship>;
	/** Objects with a `@kind` key that were not a well-formed tag. */
	malformed: number;
	/** Paths found (each also contributes its nodes and relationships). */
	paths: number;
}

/** What a result holds, for choosing a tab and for the status line. */
export interface IResultSummary {
	rowCount: number;
	columnCount: number;
	nodeCount: number;
	relationshipCount: number;
	pathCount: number;
	/** Relationships whose start or end node is not in the result. */
	danglingRelationships: number;
	/** True when at least one node can be drawn. */
	drawable: boolean;
	/** True when no cell holds a node, relationship or path. */
	scalarOnly: boolean;
	malformed: number;
	/** Integers beyond 2^53 that arrived as plain JSON numbers (an old node, or rounding before the app saw them). */
	unsafeNumbers: number;
}

/** The result tabs. */
export type ResultTab = 'graph' | 'table' | 'raw';

// =============================================================================
// ENTITY COLLECTION
// =============================================================================

/**
 * Collect the distinct nodes and relationships in a result's rows. Lists, maps
 * and paths are walked (a `collect(n)` cell holds nodes); a node's or
 * relationship's own properties are not (they cannot hold entities). The walk
 * is bounded in depth and in visits, so a hostile response cannot exhaust
 * memory here.
 *
 * @param rows - The result rows.
 * @returns The distinct entities.
 */
export function collectEntities(rows: ReadonlyArray<ReadonlyArray<unknown>>): IEntities {
	const out: IEntities = { nodes: new Map(), relationships: new Map(), malformed: 0, paths: 0 };
	let visits = 0;

	/**
	 * Walk one value.
	 *
	 * @param value - A cell or a part of one.
	 * @param depth - Current depth.
	 */
	const walk = (value: unknown, depth: number): void => {
		if (visits++ > MAX_VISITS || depth > MAX_DEPTH) return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1);
			return;
		}
		if (!isPlainObject(value)) return;
		if (isGraphNode(value)) {
			if (!out.nodes.has(value.id)) out.nodes.set(value.id, value);
			return;
		}
		if (isGraphRelationship(value)) {
			if (!out.relationships.has(value.id)) out.relationships.set(value.id, value);
			return;
		}
		if (isGraphPath(value)) {
			out.paths += 1;
			for (const node of value.nodes) if (!out.nodes.has(node.id)) out.nodes.set(node.id, node);
			for (const rel of value.relationships) if (!out.relationships.has(rel.id)) out.relationships.set(rel.id, rel);
			return;
		}
		if (isTagged(value)) return; // temporal, point, number: scalars
		if (hasKindKey(value)) {
			out.malformed += 1;
			return;
		}
		for (const key of Object.keys(value)) walk(value[key], depth + 1);
	};

	for (const row of rows) for (const cell of row) walk(cell, 0);
	return out;
}

/**
 * Summarise a result.
 *
 * @param result - A `read_query` envelope.
 * @returns Counts and the facts the UI keys on.
 */
export function summarizeResult(result: Pick<ReadQueryResult, 'columns' | 'rows'>): IResultSummary {
	const entities = collectEntities(result.rows);
	let dangling = 0;
	for (const rel of entities.relationships.values()) {
		if (!entities.nodes.has(rel.start) || !entities.nodes.has(rel.end)) dangling += 1;
	}
	return {
		rowCount: result.rows.length,
		columnCount: result.columns.length,
		nodeCount: entities.nodes.size,
		relationshipCount: entities.relationships.size,
		pathCount: entities.paths,
		danglingRelationships: dangling,
		drawable: entities.nodes.size > 0,
		scalarOnly: entities.nodes.size === 0 && entities.relationships.size === 0 && entities.paths === 0,
		malformed: entities.malformed,
		unsafeNumbers: countUnsafeNumbers(result.rows),
	};
}

/**
 * Which tab a fresh result opens in: the graph when there is something to draw,
 * the table for everything else (scalar-only results, rows with no nodes).
 *
 * @param summary - The result summary.
 * @returns The tab to open.
 */
export function chooseTab(summary: IResultSummary): ResultTab {
	return summary.drawable ? 'graph' : 'table';
}

// =============================================================================
// GRID KEYS AND ROWS
// =============================================================================

/**
 * Stable generated grid keys, one per column position. Position-keyed, never
 * name-keyed: a result with `a, a` has two columns and two keys.
 *
 * @param columns - The result's column names.
 * @returns `['c0', 'c1', ...]`.
 */
export function columnKeys(columns: readonly string[]): string[] {
	return columns.map((_, index) => `c${index}`);
}

/**
 * Rows keyed for the grid: `{ c0: cell0, c1: cell1, ..., __row: index }`.
 *
 * @param result - A `read_query` envelope.
 * @returns One object per row.
 */
export function toGridRows(result: Pick<ReadQueryResult, 'columns' | 'rows'>): Array<Record<string, unknown>> {
	const keys = columnKeys(result.columns);
	return result.rows.map((row, index) => {
		const record: Record<string, unknown> = { __row: index };
		for (let i = 0; i < keys.length; i++) record[keys[i]] = row[i];
		return record;
	});
}

// =============================================================================
// TABLE COLUMN TYPES AND THE RAW VIEW
// =============================================================================

/** The grid types a result column may take. */
export type ColumnGridType = 'string' | 'number';

/**
 * The grid type of each column: `number` only when every non-null cell is a JSON
 * number (so numeric sort and filters apply), `string` for everything else
 * (entities, tags, text, lists, maps). A number TAG is text on purpose: it never
 * gets numeric treatment that could round it.
 *
 * @param result - A result's columns and rows.
 * @returns One type per column position.
 */
export function columnGridTypes(result: Pick<ReadQueryResult, 'columns' | 'rows'>): ColumnGridType[] {
	return result.columns.map((_, i) => {
		let seen = false;
		for (const row of result.rows) {
			const cell = row[i];
			if (cell === null || cell === undefined) continue;
			if (typeof cell !== 'number') return 'string';
			seen = true;
		}
		return seen ? 'number' : 'string';
	});
}

/** How much of the Raw view is rendered; the whole text can still be copied. */
export const RAW_VIEW_LIMIT = 400_000;

/**
 * The Raw view's text: the whole envelope as pretty JSON, bounded for display.
 *
 * @param result - A `read_query` envelope.
 * @returns The text to show, whether it was cut, and the full text's length.
 */
export function rawView(result: unknown): { text: string; cut: boolean; length: number } {
	const full = toJsonText(result, 2);
	return full.length <= RAW_VIEW_LIMIT ? { text: full, cut: false, length: full.length } : { text: full.slice(0, RAW_VIEW_LIMIT), cut: true, length: full.length };
}
