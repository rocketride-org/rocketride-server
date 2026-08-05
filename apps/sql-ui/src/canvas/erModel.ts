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
// CANVAS — ER MODEL (schema snapshot -> xyflow nodes and edges)
// =============================================================================

import type { Edge, Node } from '@xyflow/react';
import type { ISqlSchemaResponse } from '../connect';

// =============================================================================
// NODE DATA
// =============================================================================

/** One column row rendered inside a table node. */
export interface IErColumn {
	/** Column name. */
	name: string;
	/** Datatype string. */
	type: string;
	/** Part of the primary key (key glyph + bold). */
	pk: boolean;
	/** Participates in a foreign key (colored glyph). */
	fk: boolean;
}

/** Data payload of a table node. */
export interface IErTableData extends Record<string, unknown> {
	/** Table name (node header). */
	table: string;
	/** Column rows in engine order. */
	columns: IErColumn[];
}

/** The xyflow node type used for tables. */
export type ErNode = Node<IErTableData, 'table'>;

// =============================================================================
// NODE SIZING (shared with the elk layout)
// =============================================================================

/** Table node width in px. */
export const NODE_WIDTH = 220;
/** Node header height in px. */
export const HEADER_HEIGHT = 30;
/** One column row height in px. */
export const ROW_HEIGHT = 22;

/**
 * Compute a table node's rendered height from its column count.
 *
 * @param columnCount - Number of column rows.
 * @returns The node height in px.
 */
export function nodeHeight(columnCount: number): number {
	return HEADER_HEIGHT + columnCount * ROW_HEIGHT + 6;
}

// =============================================================================
// HANDLE IDS
// =============================================================================

/**
 * Source-handle id for a column (right edge — FK origin).
 *
 * @param column - The column name.
 * @returns The handle id.
 */
export function sourceHandle(column: string): string {
	return `s:${column}`;
}

/**
 * Target-handle id for a column (left edge — FK destination).
 *
 * @param column - The column name.
 * @returns The handle id.
 */
export function targetHandle(column: string): string {
	return `t:${column}`;
}

// =============================================================================
// MODEL BUILD
// =============================================================================

/**
 * Build the diagram's nodes and edges from a schema snapshot. Nodes start at
 * the origin — the elk layout assigns real positions immediately after.
 *
 * @param schema - The reflected schema.
 * @returns The nodes and edges.
 */
export function buildErModel(schema: ISqlSchemaResponse): { nodes: ErNode[]; edges: Edge[] } {
	const tables = schema.tables ?? {};

	// Column names that participate in any FK, per table (drives the glyphs).
	const fkColumns = new Map<string, Set<string>>();
	for (const [name, def] of Object.entries(tables)) {
		fkColumns.set(name, new Set((def.foreign_keys ?? []).flatMap((fk) => fk.columns)));
	}

	// One node per table, its columns as rows.
	const nodes: ErNode[] = Object.entries(tables).map(([name, def]) => ({
		id: name,
		type: 'table',
		position: { x: 0, y: 0 },
		data: {
			table: name,
			columns: def.columns.map((col) => ({
				name: col.column,
				type: col.type,
				pk: (def.primary_key ?? []).includes(col.column),
				fk: fkColumns.get(name)?.has(col.column) ?? false,
			})),
		},
	}));

	// One edge per FK column pair, anchored to the exact column handles.
	const edges: Edge[] = [];
	for (const [name, def] of Object.entries(tables)) {
		for (const fk of def.foreign_keys ?? []) {
			fk.columns.forEach((col, i) => {
				const refColumn = fk.referred_columns[i] ?? fk.referred_columns[0] ?? '';
				// Skip FKs pointing outside the snapshot (cross-schema refs).
				if (!tables[fk.referred_table]) return;
				edges.push({
					id: `${name}.${col}->${fk.referred_table}.${refColumn}`,
					source: name,
					sourceHandle: sourceHandle(col),
					target: fk.referred_table,
					targetHandle: targetHandle(refColumn),
					type: 'smoothstep',
				});
			});
		}
	}

	return { nodes, edges };
}
