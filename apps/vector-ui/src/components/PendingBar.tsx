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
// VECTOR-UI - THE PENDING BAR (documents staged to move to the trash)
// =============================================================================
//
// Inside the workbench, "Move to Trash" (the Documents grid's tick, the
// document drawer, the map's review queues) stages a document instead of
// confirming at once. While anything is staged this bar says how many
// documents and, as the confirmation does, how many chunks (a sum only when
// the store counted every one), and offers:
//
//   Review    the Documents tab, listing only the staged documents;
//   Discard   unstage them all (nothing is sent);
//   Apply     the controller's one confirmation for them all (requestRemove:
//             nothing to type; Confirm sends soft_delete in batches). The
//             documents that moved, or that were already gone, leave
//             the set when the write answers (adapters/connections.ts).
//
// Apply is unavailable, with the reason shown, while writing is off or
// another write runs; the staged set stays. It is one line of a fixed height
// (PENDING_BAR_HEIGHT) for the hub's bottom slot: the short sentence and the
// reason, cut with an ellipsis where they do not fit, their whole text in
// its title. The bar renders nothing while nothing is staged, and when it
// goes the focus goes to the grid or the tab (components/focusTargets.ts),
// never to the page.
// =============================================================================

import React, { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { stagedReview } from '../adapters/consoleActions';
import { writesDuringRemoval } from '../vector/consoleModel';
import { pendingShortText, pendingText, stagedSummary, unstage } from '../vector/staged';
import { styles as appStyles } from '../styles';
import GatedButton from './GatedButton';
import { focusFell, focusWorkbench, workbenchOf } from './focusTargets';
import type { IWorkbenchPanelProps } from './workbenchProps';

/** The bar's height (px): one line, the same whatever it says, so the hub's bottom slot can hold it exactly. */
export const PENDING_BAR_HEIGHT = 32;

const styles = {
	bar: { flexShrink: 0, boxSizing: 'border-box', height: PENDING_BAR_HEIGHT, display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 8, padding: '0 12px', border: '1px solid var(--rr-border)', borderRadius: 8, background: 'var(--rr-bg-paper)', overflow: 'hidden' } as CSSProperties,
	text: { ...appStyles.small, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
};

/**
 * The pending bar.
 *
 * @param props - {@link IWorkbenchPanelProps}.
 * @returns The bar, or nothing while nothing is staged.
 */
export function PendingBar({ entry, model, console: state, actions }: IWorkbenchPanelProps): React.ReactElement | null {
	const staged = useSyncExternalStore(entry.staged.subscribe, entry.staged.get, entry.staged.get);
	const bar = useRef<HTMLDivElement>(null);
	// The workbench, read while the bar is on the page: when it goes, the focus goes to the grid or the tab there.
	const workbench = useRef<HTMLElement | null>(null);
	const reasonId = useId();
	const count = staged.size;
	const shownBefore = useRef(false);
	useEffect(() => {
		if (count > 0) {
			workbench.current = workbenchOf(bar.current);
			shownBefore.current = true;
			return;
		}
		// Gone (Discard, or the last staged document moved): focus the grid or the tab when it fell to the page.
		if (shownBefore.current && focusFell()) focusWorkbench(workbench.current);
		shownBefore.current = false;
	}, [count]);
	if (count === 0) return null;
	const writes = writesDuringRemoval(model.writes, state.removal.status);
	const reason = writes.enabled ? null : writes.reason;
	// One line: the short sentence, and why Apply waits; the whole of both in the title (and in the text it cuts).
	const summary = stagedSummary(staged);
	const why = reason === null ? '' : ` · Apply is unavailable: ${reason}`;
	return (
		<div ref={bar} role="region" aria-label="Pending changes" data-pending-bar="" style={styles.bar}>
			<span id={reasonId} role="status" style={styles.text} title={`${pendingText(summary)}${why}`}>
				{`${pendingShortText(summary)}${why}`}
			</span>
			<GatedButton
				onClick={() => {
					stagedReview(entry).set(true);
					if (actions.openTab) actions.openTab('documents');
					else entry.tab.set('documents');
				}}
			>
				Review
			</GatedButton>
			<GatedButton onClick={() => entry.staged.set(unstage(staged, [...staged.keys()]))}>Discard</GatedButton>
			<GatedButton variant="primary" unavailable={reason} describedBy={reason ? reasonId : undefined} onClick={() => entry.controller.requestRemove([...staged.values()])}>
				Apply
			</GatedButton>
		</div>
	);
}

export default PendingBar;
