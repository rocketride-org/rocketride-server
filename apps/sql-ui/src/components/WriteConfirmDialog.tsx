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
// SQL-UI — WRITE CONFIRMATION (asked before a statement the safety level flags)
// =============================================================================
//
// SQL's own dialog, in place of the shared pattern dialog: the connection's
// safety level is set in its editor, so the dialog has no answer that turns
// asking off. It says what the statement does, how many rows the planner
// expects it to change (when the database can say), how it runs, and why it
// asked: the connection's level, and that this is a check on the statement
// text.
//
// DROP and TRUNCATE ask for the target's name to be typed. The confirm button
// stays disabled until the text matches exactly, focus starts in the input,
// and Enter confirms only when it matches. Everything else starts on Cancel,
// because the dialog opens right after a Run keystroke and a second Enter must
// not send the statement. Cancel is never disabled, also while the estimate
// is still running.
// =============================================================================

import React, { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ConfirmDialog } from 'shell';
import { PATTERN_CANCEL_LABEL, focusCancelIn } from 'shared/explorer/components/PatternConfirmDialog';
import { confirmTextMatches, rowsChangeText, writeConfirmCopy } from '../sql/safety';
import type { RowEstimate, WriteConfirmation } from '../sql/safety';

/** How many lines of the statement the dialog quotes. */
const EXCERPT_LINES = 6;

/** Props for the {@link WriteConfirmDialog} component. */
export interface WriteConfirmDialogProps {
	/** Why the statement asks (from needsConfirmation). */
	confirmation: WriteConfirmation;
	/** The statement. */
	sql: string;
	/** The connection's name, for "why you were asked". */
	connection: string;
	/** The affected-row estimate, as far as it has got. */
	estimate: RowEstimate;
	/** The user's answer. */
	onAnswer: (answer: 'run' | 'cancel') => void;
}

const styles = {
	body: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
	} as CSSProperties,

	// Statement excerpt.
	excerpt: {
		margin: 0,
		padding: 8,
		maxHeight: 120,
		overflow: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		whiteSpace: 'pre-wrap',
		background: 'color-mix(in srgb, var(--rr-text-primary) 6%, transparent)',
		borderRadius: 4,
	} as CSSProperties,

	label: {
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	why: {
		fontSize: 12,
	} as CSSProperties,

	// The typed confirmation.
	confirm: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
		marginTop: 4,
	} as CSSProperties,

	name: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	input: {
		padding: '6px 10px',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		borderRadius: 4,
		fontSize: 13,
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	// Read by screen readers only.
	visuallyHidden: {
		position: 'absolute',
		width: 1,
		height: 1,
		overflow: 'hidden',
		clip: 'rect(0 0 0 0)',
		whiteSpace: 'nowrap',
	} as CSSProperties,
};

/**
 * The confirmation shown before a statement the connection's safety level
 * flags.
 *
 * @param props - {@link WriteConfirmDialogProps}.
 * @returns The dialog element.
 */
export function WriteConfirmDialog({ confirmation, sql, connection, estimate, onAnswer }: WriteConfirmDialogProps): React.ReactElement {
	// The title and the button name the rows once the estimate arrives.
	const copy = writeConfirmCopy(confirmation, sql, connection, estimate);
	const rows = rowsChangeText(confirmation, sql, estimate);
	const { target } = confirmation;
	const [typed, setTyped] = useState('');
	const matches = target === null || confirmTextMatches(typed, target);
	const inputId = useId();
	const hintId = useId();

	// Anchors the focus move: an element inside the dialog the shell renders.
	// This effect runs after the shell dialog's own, which focuses its confirm
	// button.
	const anchorRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (inputRef.current) inputRef.current.focus();
		else focusCancelIn(anchorRef.current);
	}, []);

	const lines = sql.split('\n');
	const excerpt = lines.slice(0, EXCERPT_LINES).join('\n') + (lines.length > EXCERPT_LINES ? '\n…' : '');

	return (
		<ConfirmDialog
			title={copy.title}
			destructive
			message={
				<div ref={anchorRef} style={styles.body}>
					<div>{copy.consequence}</div>
					<pre style={styles.excerpt}>{excerpt}</pre>
					{rows !== null && (
						<div>
							<span style={styles.label}>Rows that change: </span>
							<span aria-live="polite">{rows}</span>
						</div>
					)}
					<div>{copy.runsAs}</div>
					<div style={styles.why}>{copy.why}</div>
					{target && (
						<div style={styles.confirm}>
							<label htmlFor={inputId}>
								Type <span style={styles.name}>{target.confirmText}</span> to confirm
							</label>
							<input
								id={inputId}
								ref={inputRef}
								style={styles.input}
								value={typed}
								autoComplete="off"
								spellCheck={false}
								aria-describedby={hintId}
								onChange={(event) => setTyped(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== 'Enter') return;
									event.preventDefault();
									if (matches) onAnswer('run');
								}}
							/>
							<span id={hintId} style={styles.visuallyHidden} aria-live="polite">
								{matches ? 'Confirmation matches.' : `Type ${target.confirmText} exactly to enable ${copy.confirmLabel}.`}
							</span>
						</div>
					)}
				</div>
			}
			cancelLabel={PATTERN_CANCEL_LABEL}
			confirmLabel={copy.confirmLabel}
			confirmDisabled={!matches}
			onConfirm={() => { if (matches) onAnswer('run'); }}
			onCancel={() => onAnswer('cancel')}
		/>
	);
}

export default WriteConfirmDialog;
