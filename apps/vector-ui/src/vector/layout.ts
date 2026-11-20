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
// VECTOR - CONSOLE LAYOUT (pure): the panel ratios, in one constant
// =============================================================================
//
// The console's main screen: the documents on the left (38 %), the right
// column (62 %) split between adding documents (45 %) and the chat (55 %).
// Below 900 px the panels stack. The ratios live here so a change to the
// layout is one edit.
// =============================================================================

/** The console's panel ratios and the stacking breakpoint. */
export const CONSOLE_LAYOUT = { left: 0.38, right: 0.62, ingest: 0.45, chat: 0.55, stackBelowPx: 900 } as const;

/** The console's columns at one width. */
export interface IConsoleColumns {
	stacked: boolean;
	left: string;
	right: string;
	ingest: string;
	chat: string;
}

/**
 * The CSS sizes of the console's panels at a width.
 *
 * @param widthPx - The console's width (0 before it was measured).
 * @returns Whether the panels stack, and each panel's share.
 */
export function consoleColumns(widthPx: number): IConsoleColumns {
	const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;
	return {
		stacked: widthPx > 0 && widthPx < CONSOLE_LAYOUT.stackBelowPx,
		left: pct(CONSOLE_LAYOUT.left),
		right: pct(CONSOLE_LAYOUT.right),
		ingest: pct(CONSOLE_LAYOUT.ingest),
		chat: pct(CONSOLE_LAYOUT.chat),
	};
}
