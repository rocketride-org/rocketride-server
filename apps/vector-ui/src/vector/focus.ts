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
// VECTOR - WHERE THE FOCUS GOES (pure)
// =============================================================================
//
// When a control that held the focus goes away (an inline confirmation
// closing, a panel hidden by a tab switch), the focus must land on something
// the user can see, never on `<body>` and never on an element inside a hidden
// panel. These rules are plain functions over element-like objects, so they
// are tested without a browser.
// =============================================================================

/** What the rules read of an element. */
export interface IFocusCandidate {
	/** False once it left the page. */
	isConnected: boolean;
	/** Null when it, or an ancestor, is not displayed (display: none). */
	offsetParent: unknown;
	focus(): void;
}

/**
 * Whether the focus was lost when a region closed: nothing has it, the page body has it, or it is still inside the
 * region that went away.
 *
 * @param active - `document.activeElement`.
 * @param body - `document.body`.
 * @param region - The region that closed, or null.
 * @returns True when the focus should be moved.
 */
export function focusLost(active: unknown, body: unknown, region: { contains(node: never): boolean } | null): boolean {
	return active === null || active === undefined || active === body || (region !== null && region.contains(active as never));
}

/**
 * The first candidate focus can go to: still on the page and shown.
 *
 * @param candidates - In order of preference (null for one that does not exist).
 * @returns The candidate, or null when none can take the focus.
 */
export function firstFocusable<T extends IFocusCandidate>(candidates: ReadonlyArray<T | null | undefined>): T | null {
	for (const candidate of candidates) if (candidate && candidate.isConnected && candidate.offsetParent !== null) return candidate;
	return null;
}
