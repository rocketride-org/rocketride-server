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
// SQL — FAILURE TEXT (what to say when a statement does not run)
// =============================================================================
//
// The node raises three failures that mean something specific to the user, and
// one that means the app cannot tell them anything useful. All four are
// recognised HERE, by the text the backend actually produces, so the wording
// is single-sourced and testable:
//
//   `execute tool is disabled for this node (set allow_execute=true)`
//        (db_instance_base.py:287) — execute is switched off on the node.
//   `EXECUTE query exceeded max_execute_rows=<n>`
//        (db_instance_base.py:600) — the node's own row cap, not the app's.
//   `SQL execution failed (check server logs for details)`
//        (db_instance_base.py:309) — the driver's message was SWALLOWED by
//        node versions that predate the error-text fix. The app must say so
//        rather than present this as what the database said.
//   `SQL execution failed: <driver's primary message>`
//        (db_instance_base.py `execute` / `_executeRawQuery`, both the
//        session-bound and the plain path) — a node that DOES return the
//        driver's text wraps it in that prefix. The prefix is the node
//        talking, so the headline quotes what follows it; the verbatim block
//        keeps the whole string.
//   anything else — the database's own text, shown verbatim.
//
// Both node generations are handled at once, on purpose: this app is deployed
// against whatever node a workspace happens to run, so the older placeholder
// and the newer prefixed message both have to read correctly.
//
// Matching is on a SUBSTRING of the machine-stable part of each message
// (`allow_execute`, `max_execute_rows`), never on the whole sentence, so a
// reworded backend message keeps working.
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

/** What a failed execute means and what to show for it. */
export interface IFailureNotice {
	/** Banner headline: `Database reported: <first line>`. */
	headline: string;
	/** The full message, shown verbatim in the collapsible block. */
	verbatim: string;
	/**
	 * True when the node returned its generic placeholder instead of the
	 * driver's text — the app has nothing real to show and says so.
	 */
	generic: boolean;
	/** True when execute is disabled on the node (`allow_execute` is off). */
	allowExecuteOff: boolean;
	/** The node's row cap, when the failure was an overflow of it. */
	maxExecuteRows: number | null;
}

// =============================================================================
// BOUND WORDING
// =============================================================================

/** Shown instead of a headline when the node swallowed the driver's text. */
export const GENERIC_ERROR_TEXT = 'The database\'s message was not returned by this node version. The pipeline node\'s log has it.';

/** Persistent warning when the node refuses to execute anything. */
export const ALLOW_EXECUTE_OFF_TEXT = 'This node does not allow execute (allow_execute is off). Schema browsing works; statements cannot run.';

/** Title of the collapsible block holding the verbatim driver text. */
export const DATABASE_SAID_LABEL = 'Database said';

/** Refusal shown instead of running transaction-control statements. */
export const TRANSACTION_REFUSAL_TEXT = 'Transaction statements have no effect here: each statement runs and commits on its own.';

// =============================================================================
// PATTERNS
// =============================================================================

/** The node's placeholder for a swallowed driver message. */
const GENERIC_FAILURE = /SQL execution failed \(check server logs for details\)/i;

/**
 * The node's own wrapper around a driver message.
 *
 * Only the HEADLINE strips it, because the headline is introduced by
 * `Database reported:` and the prefix is the NODE speaking. The verbatim block
 * keeps every character, since that is the text that gets pasted into a bug
 * report. The placeholder above carries a parenthesis rather than a colon, so
 * it never matches here and stays generic.
 */
const NODE_EXECUTE_PREFIX = /^SQL execution failed:\s*/i;

/** The node's row-cap overflow, carrying the cap. */
const MAX_ROWS = /max_execute_rows[=:\s]+(\d+)/i;

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * The node's row-cap message, phrased for the user.
 *
 * @param cap - The cap the node reported.
 * @returns The hint to show under the error banner.
 */
export function maxRowsText(cap: number): string {
	return `The node caps results at ${cap.toLocaleString()} rows; choose a lower limit or add LIMIT.`;
}

/**
 * Read a failed execute's message.
 *
 * @param message - The error text as it reached the app.
 * @returns What to show for it.
 */
export function describeFailure(message: string): IFailureNotice {
	const verbatim = (message ?? '').trim();
	const firstLine = verbatim.split('\n')[0]?.trim() ?? '';
	// What the DATABASE said: the node's wrapper is not part of it, and the
	// headline attributes this sentence to the database by name.
	const said = firstLine.replace(NODE_EXECUTE_PREFIX, '').trim();
	const maxRows = MAX_ROWS.exec(verbatim);
	return {
		headline: `Database reported: ${said}`,
		verbatim,
		// No text at all is the same situation as the node's placeholder: there
		// is nothing real to quote. Calling it generic picks the bound wording
		// instead of rendering the headline "Database reported:" with nothing
		// after it. A wrapper with nothing behind it is that same situation.
		generic: said === '' || GENERIC_FAILURE.test(verbatim),
		allowExecuteOff: verbatim.includes('allow_execute'),
		maxExecuteRows: maxRows ? Number(maxRows[1]) : null,
	};
}
