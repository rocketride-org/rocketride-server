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
// "The viewport" is the part of the window the panel can be seen in: the
// window, cut down by every ancestor that clips its content (overflow other
// than visible), so a menu inside a scrolling or clipped card stays inside it
// (clipArea).
//
// And what a key does in an open popover: Escape closes it and puts the focus
// back on its button, unless an inner control already handled the key
// (defaultPrevented). Nothing here stops an event. focusHold is the toolbar's
// rule for a focused control that is disabled or removed under the focus (a
// sample being drawn disables the controls; Cancel goes when the layout ends):
// the toolbar takes the focus, never the page, and gives it back to a
// disabled control once it is enabled again.
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

/** The area a panel can be seen in, viewport pixels. */
export interface IPopoverArea {
	width: number;
	height: number;
	/** Its left edge (0: the window's). */
	left?: number;
	/** Its top edge (0: the window's). */
	top?: number;
}

/**
 * The window cut down by the clipping ancestors' rectangles.
 *
 * @param viewport - window.innerWidth and innerHeight.
 * @param clips - The rectangles of the ancestors that clip (overflow other than visible).
 * @returns The area left (never negative in size).
 */
export function clipArea(viewport: { width: number; height: number }, clips: readonly IPopoverAnchor[]): Required<IPopoverArea> {
	let left = 0;
	let top = 0;
	let right = viewport.width;
	let bottom = viewport.height;
	for (const c of clips) {
		left = Math.max(left, c.left);
		top = Math.max(top, c.top);
		right = Math.min(right, c.right);
		bottom = Math.min(bottom, c.bottom);
	}
	return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
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
 * @param viewport - The area it can be seen in: the window (innerWidth, innerHeight), or clipArea's.
 * @param margin - Space kept from the viewport's edges.
 * @param gap - Space between the button and the panel.
 * @returns The panel's place and caps.
 */
export function placePopover(anchor: IPopoverAnchor, panel: { width: number; height: number }, viewport: IPopoverArea, margin = POPOVER_MARGIN, gap = POPOVER_GAP): IPopoverPlace {
	const x0 = viewport.left ?? 0;
	const y0 = viewport.top ?? 0;
	const x1 = x0 + viewport.width;
	const y1 = y0 + viewport.height;
	const maxWidth = Math.max(0, viewport.width - 2 * margin);
	const width = Math.min(panel.width, maxWidth);
	let left = anchor.left + width <= x1 - margin ? anchor.left : anchor.right - width;
	left = Math.max(x0 + margin, Math.min(left, x1 - margin - width));
	const below = Math.max(0, y1 - margin - (anchor.bottom + gap));
	const above = Math.max(0, anchor.top - gap - (y0 + margin));
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

/** A control the toolbar knows about: still in it, and whether it is disabled. */
export interface IHoldControl {
	inside: boolean;
	disabled: boolean;
}

/** What the toolbar sees after a render. */
export interface IFocusHoldInput {
	/** The control that last had the focus in the toolbar (null after the focus left it). */
	last: IHoldControl | null;
	/** The control the toolbar holds the focus for, or null. */
	held: IHoldControl | null;
	/** Where the focus is: on that last control, on the toolbar itself, on the page (body, nothing) or elsewhere. */
	active: 'last' | 'toolbar' | 'page' | 'other';
}

/**
 * What the toolbar does with the focus after a render.
 *
 * - 'hold': the last control is disabled under the focus: the toolbar takes the focus and keeps the control to give it back;
 * - 'take': the last control is gone (unmounted) and the focus fell to the page: the toolbar takes it;
 * - 'give-back': the held control is enabled again while the toolbar still has the focus;
 * - 'release': the focus moved on, or the held control is gone: forget it;
 * - 'none'.
 *
 * @param input - The controls and where the focus is.
 * @returns The action.
 */
export function focusHold(input: IFocusHoldInput): 'none' | 'hold' | 'take' | 'give-back' | 'release' {
	if (input.held !== null) {
		if (input.active !== 'toolbar' || !input.held.inside) return 'release';
		return input.held.disabled ? 'none' : 'give-back';
	}
	const last = input.last;
	if (last === null || (input.active !== 'last' && input.active !== 'page')) return 'none';
	if (!last.inside) return input.active === 'page' ? 'take' : 'none';
	return last.disabled ? 'hold' : 'none';
}

/**
 * Which control of an opened panel takes the focus: the first one that is neither disabled nor hidden.
 *
 * @param controls - The panel's focusable controls, in document order.
 * @returns Its index, or -1 when there is none (the panel itself takes the focus).
 */
export function firstEnabled(controls: ReadonlyArray<{ disabled: boolean; hidden: boolean }>): number {
	return controls.findIndex((c) => !c.disabled && !c.hidden);
}
