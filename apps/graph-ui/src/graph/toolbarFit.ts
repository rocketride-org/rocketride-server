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
// GRAPH - TOOLBAR FIT (what stays on the row, pure)
// =============================================================================
//
// The graph toolbar never wraps: when its actions do not fit the width it has
// (the inspector and the legend take 320 px of the document, and a VS Code panel
// is narrow), the ones with the lowest keep-priority move to a "More" menu, one
// at a time, until the rest fit together with the More button. Search, View and
// Export are the fixed part and always stay. The order is a fixed property of
// each action, never of the width, so a given width always gives the same row.
// =============================================================================

/** One action that can leave the row. */
export interface IToolbarSlot {
	id: string;
	/** Its width on the row, as last measured. */
	width: number;
	/** Higher stays longer. */
	keep: number;
}

/** What the row has to fit into. */
export interface IToolbarSpace {
	/** The width of the row. */
	available: number;
	/** The width of what always stays (search, View, Export, ...). */
	fixed: number;
	/** The space between two items. */
	gap: number;
	/** The width of the More button. */
	moreWidth: number;
}

/**
 * Decide which actions leave the row.
 *
 * @param slots - The actions in row order.
 * @param space - The room there is.
 * @returns The ids that move to More, and whether the More button is shown.
 */
export function fitToolbar(slots: readonly IToolbarSlot[], space: IToolbarSpace): { hidden: string[]; showMore: boolean } {
	const need = (shown: readonly IToolbarSlot[], more: boolean): number => space.fixed + shown.reduce((sum, s) => sum + s.width + space.gap, 0) + (more ? space.moreWidth + space.gap : 0);
	if (need(slots, false) <= space.available) return { hidden: [], showMore: false };
	// Lowest keep first; among equals the one later in the row.
	const order = slots.map((slot, index) => ({ slot, index })).sort((a, b) => a.slot.keep - b.slot.keep || b.index - a.index);
	const hidden = new Set<string>();
	for (const { slot } of order) {
		hidden.add(slot.id);
		if (need(slots.filter((s) => !hidden.has(s.id)), true) <= space.available) break;
	}
	return { hidden: slots.filter((s) => hidden.has(s.id)).map((s) => s.id), showMore: true };
}
