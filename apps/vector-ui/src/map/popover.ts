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
// MAP - POPOVER PLACEMENT AND KEYS (pure)
// =============================================================================
//
// Where a popover that hangs from a toolbar button goes (the Advanced, Export
// and Views panels), worked out from measured rectangles before the browser
// paints, so a panel is never drawn outside the viewport and then moved:
//
//   - below the button when it fits, else above it when it fits there, else on
//     the side with more room, with its height capped to that room (the panel
//     scrolls);
//   - from the button's left edge when it fits, else ending at its right edge,
//     then clamped inside the viewport's margins; never wider than the viewport.
//
// And what a key does in an open popover: Escape closes it and puts the focus
// back on its button, unless an inner control already handled the key
// (defaultPrevented). Nothing here stops an event.
// =============================================================================

/** A rectangle in viewport (CSS) pixels. */
export interface IPopoverAnchor {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Where to put the panel, in viewport pixels. */
export interface IPopoverPlace {
	left: number;
	top: number;
	/** The panel's height cap (its content scrolls past it). */
	maxHeight: number;
	/** Its width cap. */
	maxWidth: number;
	side: 'below' | 'above';
}

/** Space kept between a panel and the viewport's edges. */
export const POPOVER_MARGIN = 8;

/** Space between the button and the panel. */
export const POPOVER_GAP = 4;

/**
 * Place a panel against its button inside the viewport.
 *
 * @param anchor - The button's rectangle.
 * @param panel - The panel's measured size.
 * @param viewport - window.innerWidth and innerHeight.
 * @param margin - Space kept from the viewport's edges.
 * @param gap - Space between the button and the panel.
 * @returns The panel's place and caps.
 */
export function placePopover(anchor: IPopoverAnchor, panel: { width: number; height: number }, viewport: { width: number; height: number }, margin = POPOVER_MARGIN, gap = POPOVER_GAP): IPopoverPlace {
	const maxWidth = Math.max(0, viewport.width - 2 * margin);
	const width = Math.min(panel.width, maxWidth);
	let left = anchor.left + width <= viewport.width - margin ? anchor.left : anchor.right - width;
	left = Math.max(margin, Math.min(left, viewport.width - margin - width));
	const below = Math.max(0, viewport.height - margin - (anchor.bottom + gap));
	const above = Math.max(0, anchor.top - gap - margin);
	const side: 'below' | 'above' = panel.height <= below || (panel.height > above && below >= above) ? 'below' : 'above';
	const maxHeight = side === 'below' ? below : above;
	const height = Math.min(panel.height, maxHeight);
	const top = side === 'below' ? anchor.bottom + gap : anchor.top - gap - height;
	return { left, top, maxHeight, maxWidth, side };
}

/** What a key does in an open popover. */
export interface IPopoverKey {
	/** Close the popover. */
	close: boolean;
	/** Put the focus back on its button. */
	refocus: boolean;
	/** Call preventDefault (the key was handled here). */
	prevent: boolean;
}

/**
 * The popover's own keys: Escape closes it and returns the focus, unless an
 * inner control handled it first.
 *
 * @param key - KeyboardEvent.key.
 * @param defaultPrevented - Whether an inner handler already acted on it.
 * @returns What to do.
 */
export function popoverKey(key: string, defaultPrevented: boolean): IPopoverKey {
	if (key === 'Escape' && !defaultPrevented) return { close: true, refocus: true, prevent: true };
	return { close: false, refocus: false, prevent: false };
}
