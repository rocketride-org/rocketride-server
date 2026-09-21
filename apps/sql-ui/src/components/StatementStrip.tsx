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
// SQL-UI — STATEMENT STRIP (per-statement outcomes for a multi-statement run)
// =============================================================================
//
// One row of buttons, one per statement of the last batch, showing what each
// one did and selecting which result the grid shows. The shell has no list or
// menu component for this shape, so it is app-local — but it is built from
// shell primitives (Button, StatusBadge) and uses real buttons in a `role=list`
// so every item has a complete accessible name.
//
// Nothing here is conveyed by colour alone: the badge always carries text, and
// the label repeats the outcome in words.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, StatusBadge } from 'shell';
import type { StatusVariant } from 'shell';
import type { IStatementRun } from '../sql/batch';
import { formatRunLabel } from '../sql/batch';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link StatementStrip} component. */
export interface IStatementStripProps {
	/** The batch's statements, in order. */
	runs: IStatementRun[];
	/** Index of the statement whose result the grid is showing. */
	selected: number | null;
	/** Fired with a statement index when the user picks one. */
	onSelect: (index: number) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	strip: {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'center',
		gap: 6,
		listStyle: 'none',
		margin: 0,
		padding: 0,
	} as CSSProperties,

	item: {
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,

	// Badge sits inside the button label, ahead of the text.
	badge: {
		marginRight: 6,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The badge variant and its short word for one outcome.
 *
 * @param run - The statement.
 * @returns The badge variant and text.
 */
function badgeFor(run: IStatementRun): { variant: StatusVariant; text: string } {
	switch (run.outcome) {
		case 'rows':
			return { variant: 'success', text: 'rows' };
		case 'affected':
			return { variant: 'info', text: 'affected' };
		case 'error':
			return { variant: 'error', text: 'error' };
		case 'abandoned':
			return { variant: 'muted', text: 'abandoned' };
		case 'running':
			return { variant: 'info', text: 'running' };
		case 'skipped':
			return { variant: 'muted', text: 'not run' };
		default:
			return { variant: 'muted', text: 'queued' };
	}
}

/**
 * Tooltip explaining a statement's state where the label alone is terse.
 *
 * @param run - The statement.
 * @returns The tooltip text.
 */
function titleFor(run: IStatementRun): string {
	// A statement rerun from the history drawer has no place in the buffer, so
	// it gets no line reference rather than a made-up one.
	const lines = run.startLine === undefined || run.endLine === undefined
		? ''
		: run.startLine === run.endLine ? ` (line ${run.startLine})` : ` (lines ${run.startLine}–${run.endLine})`;
	if (run.outcome === 'skipped') return `Not run${lines}: an earlier statement failed.`;
	if (run.outcome === 'abandoned') return `Abandoned${lines}: this tool stopped waiting; the database may still be running it.`;
	return `Show the result of statement ${run.index + 1}${lines}.`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The per-statement status strip for the last batch.
 *
 * Rendered only when a batch held more than one statement; for a single
 * statement the result meta line already carries everything this would say.
 *
 * @param props - {@link IStatementStripProps}.
 * @returns The strip element, or null for a batch of one.
 */
export const StatementStrip: React.FC<IStatementStripProps> = ({ runs, selected, onSelect }) => {
	if (runs.length < 2) return null;
	return (
		<ul style={styles.strip} role="list" aria-label="Statements in the last run">
			{runs.map((run) => {
				const badge = badgeFor(run);
				const selectable = run.outcome === 'rows' || run.outcome === 'affected' || run.outcome === 'error';
				return (
					<li key={run.index} style={styles.item}>
						<Button
							variant="ghost"
							small
							pressed={selected === run.index}
							disabled={!selectable}
							title={titleFor(run)}
							onClick={() => onSelect(run.index)}
						>
							<span style={styles.badge}>
								<StatusBadge variant={badge.variant}>{badge.text}</StatusBadge>
							</span>
							{formatRunLabel(run)}
						</Button>
					</li>
				);
			})}
		</ul>
	);
};

export default StatementStrip;
