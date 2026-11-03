// MIT License
//
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
// LINE DIFF — unified line diff for the SCM change viewer
// =============================================================================
//
// A dependency-free LCS line diff, sized for review tabs: common prefix and
// suffix are trimmed first (the overwhelming bulk of a typical edit), the
// middle runs an O(n·m) LCS, and a middle too large for that budget falls
// back to whole-block replace — a correct (if coarse) diff, never a hang.
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

/** One rendered diff line. */
export interface DiffLine {
	/** 'same' = context, 'add' = only in after, 'del' = only in before. */
	type: 'same' | 'add' | 'del';
	/** The line's text (no trailing newline). */
	text: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** LCS budget: middle sections whose n·m exceeds this replace wholesale. */
const LCS_CELL_BUDGET = 4_000_000;

// =============================================================================
// DIFF
// =============================================================================

/**
 * Computes a unified line diff between two texts.
 *
 * @param before - The base text (null = the file did not exist).
 * @param after - The staged text (null = the file is deleted).
 * @returns Ordered diff lines (context, deletions, additions).
 */
export function diffLines(before: string | null, after: string | null): DiffLine[] {
	const a = before == null ? [] : before.split('\n');
	const b = after == null ? [] : after.split('\n');

	// step: trim the common prefix and suffix — the cheap 99% of most edits
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const out: DiffLine[] = [];
	for (let i = 0; i < start; i++) out.push({ type: 'same', text: a[i] });

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);

	if (midA.length * midB.length > LCS_CELL_BUDGET) {
		// step: over budget — coarse whole-block replace, never a hang
		for (const text of midA) out.push({ type: 'del', text });
		for (const text of midB) out.push({ type: 'add', text });
	} else {
		out.push(...lcsDiff(midA, midB));
	}

	for (let i = endA; i < a.length; i++) out.push({ type: 'same', text: a[i] });
	return out;
}

/**
 * Classic LCS diff over the (already trimmed) middle sections.
 *
 * @param a - Before lines.
 * @param b - After lines.
 * @returns Diff lines for the middle.
 */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
	const n = a.length;
	const m = b.length;
	// step: LCS length table (n+1 × m+1), row-major in a flat array
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * width + j] = a[i] === b[j]
				? table[(i + 1) * width + j + 1] + 1
				: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	// step: walk the table, emitting dels before adds within each hunk
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ type: 'same', text: a[i] });
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			out.push({ type: 'del', text: a[i] });
			i++;
		} else {
			out.push({ type: 'add', text: b[j] });
			j++;
		}
	}
	while (i < n) out.push({ type: 'del', text: a[i++] });
	while (j < m) out.push({ type: 'add', text: b[j++] });
	return out;
}
