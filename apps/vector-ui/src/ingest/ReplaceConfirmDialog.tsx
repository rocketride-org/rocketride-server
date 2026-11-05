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
// VECTOR-UI — ReplaceConfirmDialog (before a dropped file replaces a stored one)
// =============================================================================
//
// The shell's ConfirmDialog in its destructive style. The shell focuses the
// confirm button; this dialog moves the focus to Cancel when it mounts, so
// Enter never replaces a document by accident. Mount it only while the
// question is open.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { ConfirmDialog } from 'shell';
import { focusCancelIn } from 'shared/explorer/components/PatternConfirmDialog';
import type { ReplaceQuestion } from '../vector/uploads';

/** Props of {@link ReplaceConfirmDialog}. */
export interface ReplaceConfirmDialogProps {
	question: ReplaceQuestion;
	onReplace(): void;
	onCancel(): void;
}

/**
 * Ask before dropped files replace stored documents.
 *
 * @param props - {@link ReplaceConfirmDialogProps}.
 * @returns The dialog.
 */
export function ReplaceConfirmDialog({ question, onReplace, onCancel }: ReplaceConfirmDialogProps): React.ReactElement {
	// An element inside the dialog the shell renders, so the focus step can find its Cancel button.
	const anchor = useRef<HTMLDivElement>(null);
	useEffect(() => {
		focusCancelIn(anchor.current, question.cancelLabel);
	}, [question.cancelLabel]);

	const [lead, ...rest] = question.message;
	const list = rest.length > 1 ? rest.slice(0, -1) : [];
	const tail = rest.length > 1 ? rest[rest.length - 1] : rest[0];
	return (
		<ConfirmDialog
			title={question.title}
			destructive
			confirmLabel={question.confirmLabel}
			cancelLabel={question.cancelLabel}
			message={
				<div ref={anchor}>
					<p style={{ margin: '0 0 6px' }}>{lead}</p>
					{list.length > 0 && (
						<ul style={{ margin: '4px 0 6px', paddingLeft: 20, maxHeight: 220, overflow: 'auto' }}>
							{list.map((line) => (
								<li key={line} style={{ overflowWrap: 'anywhere' }}>
									{line}
								</li>
							))}
						</ul>
					)}
					{tail !== undefined && <p style={{ margin: '6px 0 0' }}>{tail}</p>}
				</div>
			}
			onConfirm={onReplace}
			onCancel={onCancel}
		/>
	);
}

export default ReplaceConfirmDialog;
