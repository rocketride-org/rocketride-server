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
// GRAPH - LEGEND (every label on the canvas, with its colour and count)
// =============================================================================
//
// The legend is what makes colour optional: each label on the canvas is named next
// to its swatch, and counts say how many drawn nodes carry it. A node is counted
// under its FIRST label (the one that sets its colour); a node with no label is
// listed as "(no label)". Counts are of the nodes DRAWN, never of the database.
// =============================================================================

import { colorFor } from './colors';
import type { ILabelColor } from './colors';
import type { IGraphModel } from './model';

/** One legend line. */
export interface ILegendEntry {
	/** The label ('' for nodes with none). */
	label: string;
	/** What to print. */
	name: string;
	fill: string;
	count: number;
}

/**
 * The legend of a model.
 *
 * @param model - The canvas model.
 * @param colors - The connection's label colours.
 * @returns Entries, most nodes first, then by name.
 */
export function legendOf(model: Pick<IGraphModel, 'nodes'>, colors: ReadonlyMap<string, ILabelColor>): ILegendEntry[] {
	const counts = new Map<string, number>();
	for (const node of model.nodes.values()) {
		const label = node.labels[0] ?? '';
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([label, count]) => ({ label, name: label === '' ? '(no label)' : label, fill: colorFor(colors, label).fill, count }))
		.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
