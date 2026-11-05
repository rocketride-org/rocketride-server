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
// GRAPH - EXPORT WORDING (what an image export that made no image says)
// =============================================================================
//
// The canvas answers an image export with a blob, or with no blob and the
// reason. Each reason has its own sentence, so "too large" is never said for a
// drawing that was simply not ready. An answer in the older shape (a Blob, or
// null) is read too: null with no reason is a failure to render.
// =============================================================================

/** Why there is no image. */
export type ExportFailure = 'too-large' | 'not-ready' | 'render-failed';

/** What an export came to. */
export interface IExportOutcome {
	blob: Blob | null;
	reason: ExportFailure | null;
}

/**
 * Read whatever the canvas answered an export with.
 *
 * @param raw - A Blob, null, or `{ blob }` / `{ blob: null, reason }`.
 * @returns The blob, or the reason there is none.
 */
export function exportOutcome(raw: unknown): IExportOutcome {
	if (typeof Blob !== 'undefined' && raw instanceof Blob) return { blob: raw, reason: null };
	if (raw !== null && typeof raw === 'object' && 'blob' in raw) {
		const { blob, reason } = raw as { blob: unknown; reason?: unknown };
		if (typeof Blob !== 'undefined' && blob instanceof Blob) return { blob, reason: null };
		return { blob: null, reason: reason === 'too-large' || reason === 'not-ready' || reason === 'render-failed' ? reason : 'render-failed' };
	}
	return { blob: null, reason: 'render-failed' };
}

/**
 * The sentence for a failed export.
 *
 * @param reason - Why there is no image.
 * @param format - What was asked for.
 * @returns Plain text for the live region.
 */
export function exportFailureText(reason: ExportFailure, format: 'svg' | 'png'): string {
	switch (reason) {
		case 'too-large':
			return 'Too large for a PNG; save the SVG instead.';
		case 'not-ready':
			return 'The graph is still loading; try again in a moment.';
		default:
			return format === 'png' ? 'Could not make the image; try SVG.' : 'Could not make the image.';
	}
}
