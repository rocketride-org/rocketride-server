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
// GRAPH-UI - WRITE CONFIRMATION (the write console's dialog, Cancel focused)
// =============================================================================
//
// Lists the statements the text check marks as mutating, with their text, before
// the write console sends a batch. The SAFE answer is the default one: the dialog
// opens right after Ctrl/Cmd+Enter, and the shell's ConfirmDialog focuses its
// confirm button when it mounts, so a second Enter would send the write.
//
// This component renders the shell dialog and moves focus to Cancel from its OWN
// mount effect, the shape of the shared PatternConfirmDialog. React runs a
// parent's effects after its children's, so this runs after the dialog's focus.
// Under <React.StrictMode> (the shell renders in it) a development build runs the
// mount effects of what it just mounted a second time, in the same order: the
// dialog's focus, then this. An effect in the console keyed on the dialog being
// open is not re-run that way, which left the focus on Execute.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { ConfirmDialog } from 'shell';
import { focusCancelIn } from 'shared/explorer/components/PatternConfirmDialog';
import { WRITE_CANCEL_LABEL, confirmationParagraphs } from '../graph/writeConfirm';
import type { IWriteConfirmation } from '../graph/writeConfirm';

/** Props for the {@link WriteConfirmDialog} component. */
export interface IWriteConfirmDialogProps {
	/** What to confirm: the flagged statements and the batch around them. */
	content: IWriteConfirmation;
	/** Send the batch. */
	onConfirm: () => void;
	/** Send nothing. */
	onCancel: () => void;
}

/**
 * The write console's confirmation. Mount it only while a confirmation is pending:
 * the focus moves to Cancel when it mounts.
 *
 * @param props - {@link IWriteConfirmDialogProps}.
 * @returns The dialog element.
 */
export function WriteConfirmDialog({ content, onConfirm, onCancel }: IWriteConfirmDialogProps): React.ReactElement {
	// An element inside the dialog the shell renders, so the focus step can find its Cancel button.
	const anchor = useRef<HTMLDivElement>(null);
	useEffect(() => {
		focusCancelIn(anchor.current, WRITE_CANCEL_LABEL);
	}, []);

	return (
		<ConfirmDialog
			title={content.mutating.length === 1 ? 'Run this statement?' : `Run these ${content.mutating.length} statements?`}
			destructive
			cancelLabel={WRITE_CANCEL_LABEL}
			confirmLabel={content.total === 1 ? 'Execute statement' : 'Execute statements'}
			message={
				<div ref={anchor}>
					<ol style={{ margin: '8px 0', paddingLeft: 20 }}>
						{content.mutating.map((m) => (
							<li key={m.position} style={{ marginBottom: 6 }}>
								<div>{`Statement ${m.position}${m.lines ? ` (${m.lines})` : ''}: ${m.finding}`}</div>
								<pre style={{ margin: '2px 0', padding: 6, maxHeight: 80, overflow: 'auto', fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 11, whiteSpace: 'pre-wrap', background: 'color-mix(in srgb, var(--rr-text-primary) 6%, transparent)', borderRadius: 4 }}>{m.excerpt}</pre>
							</li>
						))}
					</ol>
					{confirmationParagraphs(content).map((p) => (
						<div key={p} style={{ marginTop: 6 }}>
							{p}
						</div>
					))}
				</div>
			}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}

export default WriteConfirmDialog;
