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
// The strip itself is shared (shared/explorer/components/StatementStrip); this
// binds it to SQL's run type and its label wording.
//
// Port of 4c584a214.
// =============================================================================

import React from 'react';
import { StatementStrip as SharedStatementStrip } from 'shared/explorer/components/StatementStrip';
import type { StatementRun } from '../sql/batch';
import { formatRunLabel } from '../sql/batch';

/** Props for the {@link StatementStrip} component. */
export interface StatementStripProps {
	/** The batch's statements, in order. */
	runs: StatementRun[];
	/** Index of the statement whose result the grid is showing. */
	selected: number | null;
	/** Fired with a statement index when the user picks one. */
	onSelect: (index: number) => void;
}

/**
 * The per-statement status strip for the last batch.
 *
 * Rendered only when a batch held more than one statement; for a single
 * statement the result meta line already carries everything this would say.
 *
 * @param props - {@link StatementStripProps}.
 * @returns The strip element, or null for a batch of one.
 */
export const StatementStrip: React.FC<StatementStripProps> = ({ runs, selected, onSelect }) => (
	<SharedStatementStrip<StatementRun> runs={runs} selected={selected} onSelect={onSelect} labelOf={formatRunLabel} />
);

export default StatementStrip;
