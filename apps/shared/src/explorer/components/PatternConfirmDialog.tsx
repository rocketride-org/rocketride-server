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
// EXPLORER — PATTERN CONFIRMATION (a TEXT check, and it says so)
// =============================================================================
//
// The confirmation shown before a statement a text pattern flagged is sent. It
// prevents nothing and is not called a safe mode anywhere: the sentence
// "This is a text check, not a database safeguard." is part of the dialog and
// is not configurable. What the dialog says it DOES afterwards is the app's
// (SQL commits on its own; Graph does not claim atomicity).
//
// The SAFE answer is the default one. The dialog opens right after a Run
// keystroke, and the shell's ConfirmDialog focuses its confirm button, so a
// second Enter would send the flagged statement. This dialog moves focus to
// Cancel once it is open (its effect runs after the shell dialog's own).
// =============================================================================

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ConfirmDialog } from 'shell';
import type { PatternAnswer } from '../runner/types';

/** The sentence every confirmation carries, word for word. */
export const TEXT_CHECK_SENTENCE = 'This is a text check, not a database safeguard.';

/** The dismiss button's label, which is also how its button is found for focus. */
export const PATTERN_CANCEL_LABEL = 'Cancel';

/**
 * Focus the Cancel button of the dialog that contains `anchor`.
 *
 * @param anchor - An element inside the dialog (null before it is mounted).
 * @param label - The Cancel button's label.
 * @returns True when a Cancel button was found and focused.
 */
export function focusCancelIn(anchor: Element | null, label: string = PATTERN_CANCEL_LABEL): boolean {
	const dialog = anchor?.closest('[role="dialog"]');
	if (!dialog) return false;
	const cancel = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.trim() === label);
	if (!cancel) return false;
	cancel.focus();
	return true;
}

/** Props for the {@link PatternConfirmDialog} component. */
export interface IPatternConfirmDialogProps {
	/** What the check saw, phrased for `Pattern check: <kind> detected.` */
	kind: string;
	/** The first lines of the statement. */
	excerpt: string;
	/** What happens after Run, in the app's words (e.g. `It runs immediately and commits on its own.`). */
	consequence: string;
	/** Dialog title (default `Run this statement?`). */
	title?: string;
	/** Primary button (default `Run statement`). */
	confirmLabel?: string;
	/** Secondary button (default `Run and stop asking on this connection`). */
	secondaryLabel?: string;
	/** The user's answer. */
	onAnswer: (answer: PatternAnswer) => void;
}

const styles = {
	// Statement excerpt inside the confirmation dialog.
	excerpt: {
		margin: '8px 0',
		padding: 8,
		maxHeight: 120,
		overflow: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		whiteSpace: 'pre-wrap',
		background: 'color-mix(in srgb, var(--rr-text-primary) 6%, transparent)',
		borderRadius: 4,
	} as CSSProperties,
};

/**
 * The pattern-check confirmation.
 *
 * @param props - {@link IPatternConfirmDialogProps}.
 * @returns The dialog element.
 */
export function PatternConfirmDialog({ kind, excerpt, consequence, title = 'Run this statement?', confirmLabel = 'Run statement', secondaryLabel = 'Run and stop asking on this connection', onAnswer }: IPatternConfirmDialogProps): React.ReactElement {
	// Anchors the focus move: an element inside the dialog the shell renders.
	const anchorRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		focusCancelIn(anchorRef.current);
	}, []);

	return (
		<ConfirmDialog
			title={title}
			destructive
			message={
				<div ref={anchorRef}>
					<div>{`Pattern check: ${kind} detected. ${TEXT_CHECK_SENTENCE}`}</div>
					<pre style={styles.excerpt}>{excerpt}</pre>
					<div>{consequence}</div>
				</div>
			}
			cancelLabel={PATTERN_CANCEL_LABEL}
			confirmLabel={confirmLabel}
			secondaryLabel={secondaryLabel}
			onConfirm={() => onAnswer('run')}
			onSecondary={() => onAnswer('always')}
			onCancel={() => onAnswer('cancel')}
		/>
	);
}

export default PatternConfirmDialog;
