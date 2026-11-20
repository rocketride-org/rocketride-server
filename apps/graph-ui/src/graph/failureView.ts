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
// GRAPH - WHAT THE FAILURE BANNER SAYS (pure)
// =============================================================================
//
// The words of the banner for a failed statement, apart from the component so they
// are tested without a DOM: the headline, where the failure was (statement, line and
// column), what ran before it and what did not run after it, and the database's own
// text, verbatim.
// =============================================================================

import type { IPosition } from './errorPosition';

/** What the banner reads from a failure (the shared runner's `IFailureState`, reduced). */
export interface IFailureViewInput {
	notice: { headline: string; verbatim: string; generic: boolean };
	/** Zero-based index of the failed statement. */
	index: number;
	/** The failed statement's line range ('line 3', 'lines 4-6'), or ''. */
	lines: string;
	/** What is true of the statements before it, or ''. */
	prior: string;
}

/** What is known beyond the failure itself. */
export interface IFailureViewContext {
	/** How many statements the batch had; absent when not known. */
	total?: number;
	/** The failure's place in the editor buffer, when the database's text named one. */
	position?: IPosition | null;
	/** Said instead of the headline when the node withheld the database's text. */
	genericText: string;
}

/** The banner's lines. */
export interface IFailureView {
	headline: string;
	where: string;
	prior: string;
	/** Which statements were never started ('' when none, or when the batch size is not known). */
	notRun: string;
	/** The database's text, verbatim ('' when the node withheld it or sent only a headline). */
	verbatim: string;
	/** What "Copy error" copies. */
	copy: string;
	/** Index to run from, or null when running from it would only repeat the whole batch of one. */
	runFrom: number | null;
	runFromLabel: string;
}

/**
 * Describe a failure for the banner.
 *
 * @param failure - The failed statement.
 * @param context - The batch size, the position, and the generic line.
 * @returns The banner's lines.
 */
export function failureView(failure: IFailureViewInput, context: IFailureViewContext): IFailureView {
	const { notice, index } = failure;
	const total = context.total;
	const place = context.position ? `line ${context.position.line}, column ${context.position.column}` : failure.lines;
	const subject = total === 1 ? 'The statement' : `Statement ${index + 1}`;
	const where = `${subject} failed${place ? ` (${place})` : ''}.`;
	const after = total === undefined ? 0 : Math.max(0, total - index - 1);
	const notRun = after === 0 ? '' : after === 1 ? `Statement ${index + 2} was not run.` : `Statements ${index + 2}–${index + 1 + after} were not run.`;
	const headline = notice.generic ? context.genericText : notice.headline;
	const verbatim = notice.generic ? '' : notice.verbatim;
	const canRunFrom = total !== undefined && total > 1;
	return {
		headline,
		where,
		prior: failure.prior,
		notRun,
		verbatim,
		copy: [headline, where, verbatim].filter((part) => part !== '').join('\n'),
		runFrom: canRunFrom ? index : null,
		runFromLabel: canRunFrom ? `Run from statement ${index + 1}` : '',
	};
}
