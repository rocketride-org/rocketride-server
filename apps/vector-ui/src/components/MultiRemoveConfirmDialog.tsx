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
// VECTOR-UI — SEVERAL-DOCUMENT CONFIRMATION (Move to trash, Delete permanently, Empty trash)
// =============================================================================
//
// Lists up to 20 paths and counts the rest. Deleting permanently and emptying
// the trash stay disabled until the count (or, on rocketride_vector, the table
// name) is typed; moving to the trash types nothing, since it can be undone.
// Cancel has the focus, moved there by this component's own mount effect (see
// RemoveConfirmDialog). The write runs in batches of at most 100 and stops at
// the first error.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from 'shell';
import { focusCancelIn } from 'shared/explorer/components/PatternConfirmDialog';
import { REMOVE_CANCEL_LABEL, confirmReady } from '../vector/confirm';
import type { IMultiRemoveConfirmation } from '../vector/confirm';
import { formatCount } from '../vector/stats';
import { styles } from '../styles';

/** Props for the {@link MultiRemoveConfirmDialog} component. */
export interface IMultiRemoveConfirmDialogProps {
	content: IMultiRemoveConfirmation;
	onConfirm(): void;
	onCancel(): void;
}

/**
 * The dialog. Mount it only while a confirmation is pending.
 *
 * @param props - {@link IMultiRemoveConfirmDialogProps}.
 * @returns The dialog element.
 */
export function MultiRemoveConfirmDialog({ content, onConfirm, onCancel }: IMultiRemoveConfirmDialogProps): React.ReactElement {
	const anchor = useRef<HTMLDivElement>(null);
	const [typed, setTyped] = useState('');
	useEffect(() => {
		focusCancelIn(anchor.current, REMOVE_CANCEL_LABEL);
	}, []);
	const ready = confirmReady(content.typed, typed);
	return (
		<ConfirmDialog
			title={content.title}
			destructive={content.destructive}
			cancelLabel={content.cancelLabel}
			confirmLabel={content.confirmLabel}
			confirmDisabled={!ready}
			message={
				<div ref={anchor}>
					<ul aria-label={content.listLabel} style={{ margin: '8px 0', paddingLeft: 20, maxHeight: 180, overflowY: 'auto' }}>
						{content.listed.map((path, i) => (
							<li key={`${i}:${path}`} style={{ overflowWrap: 'anywhere' }}>
								{path}
							</li>
						))}
					</ul>
					{content.more > 0 && <p style={{ margin: '4px 0' }}>{`and ${formatCount(content.more)} more`}</p>}
					<p style={{ margin: '8px 0' }}>{content.sentence}</p>
					{content.extra.map((sentence) => (
						<p key={sentence} style={{ margin: '8px 0' }}>
							{sentence}
						</p>
					))}
					{content.typed && (
						<label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
							<span>{content.typed.prompt}</span>
							<input type="text" value={typed} onChange={(event) => setTyped(event.target.value)} style={styles.input} autoComplete="off" spellCheck={false} />
						</label>
					)}
				</div>
			}
			onConfirm={() => {
				if (ready) onConfirm();
			}}
			onCancel={onCancel}
		/>
	);
}

export default MultiRemoveConfirmDialog;
