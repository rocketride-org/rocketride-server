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
// VECTOR-UI — ONE-DOCUMENT CONFIRMATION (Move to trash, Delete permanently; Cancel focused)
// =============================================================================
//
// The shell's ConfirmDialog (destructive for Delete permanently, not for Move
// to trash, which can be undone), with the focus moved to Cancel from this
// component's OWN mount effect (the shape of the shared PatternConfirmDialog):
// React runs a parent's effects after its children's, so this runs after the
// dialog focused its confirm button, and a stray Enter cancels instead of
// writing. Deleting permanently on rocketride_vector needs the table name
// typed before its button is enabled.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from 'shell';
import { focusCancelIn } from 'shared/explorer/components/PatternConfirmDialog';
import { REMOVE_CANCEL_LABEL, confirmReady } from '../vector/confirm';
import type { IRemoveConfirmation } from '../vector/confirm';
import { styles } from '../styles';

/** Props for the {@link RemoveConfirmDialog} component. */
export interface IRemoveConfirmDialogProps {
	content: IRemoveConfirmation;
	onConfirm(): void;
	onCancel(): void;
}

/**
 * The dialog. Mount it only while a confirmation is pending.
 *
 * @param props - {@link IRemoveConfirmDialogProps}.
 * @returns The dialog element.
 */
export function RemoveConfirmDialog({ content, onConfirm, onCancel }: IRemoveConfirmDialogProps): React.ReactElement {
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
					<dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: '8px 0' }}>
						{content.lines.map((line) => (
							<React.Fragment key={line.label}>
								<dt style={{ fontWeight: 600 }}>{line.label}</dt>
								<dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{line.value}</dd>
							</React.Fragment>
						))}
					</dl>
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

export default RemoveConfirmDialog;
