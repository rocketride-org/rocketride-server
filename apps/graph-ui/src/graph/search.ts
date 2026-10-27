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
// GRAPH - CANVAS SEARCH (which drawn nodes match a query, pure)
// =============================================================================
//
// The search looks only at the nodes that are DRAWN: it never asks the database.
// A node matches when the query (case-insensitive, as a plain substring, never as
// a pattern) is in its caption, in any of its labels or in the text of any of its
// property values. Nodes whose caption matches come first, then the others, each
// group in drawing order.
// =============================================================================

import type { GraphId, GraphNode } from './types';
import { decodedText, userEntries } from './values';

/** Property values longer than this are not searched past this point (a bound on one huge string). */
const MAX_VALUE_CHARS = 2000;

/**
 * The drawn nodes matching a query.
 *
 * @param nodes - The drawn nodes, in drawing order.
 * @param query - What was typed.
 * @param captionFor - The caption the canvas shows for a node.
 * @returns Node ids, caption matches first; an empty list when nothing matches; null when the query is blank (no search).
 */
export function searchNodes(nodes: Iterable<GraphNode>, query: string, captionFor: (node: GraphNode) => string): GraphId[] | null {
	const needle = query.trim().toLowerCase();
	if (needle === '') return null;
	const byCaption: GraphId[] = [];
	const byOther: GraphId[] = [];
	for (const node of nodes) {
		if (captionFor(node).toLowerCase().includes(needle)) {
			byCaption.push(node.id);
			continue;
		}
		if (node.labels.some((label) => label.toLowerCase().includes(needle))) {
			byOther.push(node.id);
			continue;
		}
		if (userEntries(node.properties).some(([, value]) => decodedText(value).slice(0, MAX_VALUE_CHARS).toLowerCase().includes(needle))) byOther.push(node.id);
	}
	return [...byCaption, ...byOther];
}

/**
 * The line under the search box.
 *
 * @param count - How many nodes match.
 * @param current - The zero-based index of the current match.
 * @returns The text.
 */
export function searchStatusText(count: number, current: number): string {
	if (count === 0) return 'No drawn node matches';
	if (count === 1) return '1 of 1 · Enter to select';
	return `${current + 1} of ${count} · Enter to select, arrows for the next`;
}
