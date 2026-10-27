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
// VECTOR-UI - A DOCUMENT'S WRITE SLOT (its own Move to trash, said where it was asked)
// =============================================================================
//
// A document surface confirms its own Move to trash inline. What that write
// did shows in this slot at the bottom of the document: one line of the hub's
// bottom slot's height (PENDING_BAR_HEIGHT), there whenever writes are
// possible and the same whether empty or full, so a write never moves the
// Reader | Chunks row or the body. It shows what the write is doing while it
// runs, then its result (an alert when it failed) with Write details (the
// whole sentence, which the one line may cut, and the store's audit; it opens
// above the line). The hub's rules, without a pending bar (documentSlot): a
// failure or a write that did not do all it was asked stays until the next
// write, a success for a few seconds, and nothing is taken away while the
// focus or the pointer is in it.
//
// The full app's document tab shares the console's controller, so it shows
// only the writes asked under its own origin (the console's line skips them);
// a dev-tool document frame has its own controller, and shows every write of
// it.
// =============================================================================

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { IConnectionEntry } from '../adapters/connections';
import { CONSOLE_ORIGIN } from '../vector/confirm';
import type { ConfirmOrigin } from '../vector/confirm';
import { TABBABLE, firstFocusable, focusLost } from '../vector/focus';
import { RESULT_FIRST_MS, documentSlot } from '../vector/workbench';
import type { DocumentSlot, SlotWrite } from '../vector/workbench';
import { BUSY } from '../vector/wording';
import { styles as appStyles } from '../styles';
import { PENDING_BAR_HEIGHT } from './PendingBar';
import WriteAuditDetails from './WriteAuditDetails';

const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

const styles = {
	/** The hub's bottom slot, exactly: one line, always there while writes are possible. */
	slot: { flexShrink: 0, boxSizing: 'border-box', height: PENDING_BAR_HEIGHT, margin: '0 12px 8px', display: 'flex', alignItems: 'stretch', minWidth: 0 } as CSSProperties,
	line: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 8, padding: '0 12px' } as CSSProperties,
	text: { ...appStyles.small, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
};

/** Props of {@link DocumentWriteLine}. */
export interface IDocumentWriteLineProps {
	/** The connection's objects (its controller holds the write). */
	entry: Pick<IConnectionEntry, 'controller'>;
	/** The surface's origin: the writes asked under it show here. */
	origin: ConfirmOrigin;
	/** Where the focus goes when a control in the slot leaves with it: the document's tabs, else its first control. */
	returnFocus(): HTMLElement | null;
}

/**
 * The bottom slot of a document surface, with the line of the last write asked on it.
 *
 * @param props - {@link IDocumentWriteLineProps}.
 * @returns The slot (empty while there is nothing to say).
 */
export function DocumentWriteLine({ entry, origin, returnFocus }: IDocumentWriteLineProps): React.ReactElement {
	const removal = useSyncExternalStore(entry.controller.subscribe, () => entry.controller.getState().removal, () => entry.controller.getState().removal);
	const mine = (removal.origin ?? CONSOLE_ORIGIN) === origin;
	const write: SlotWrite = !mine || (removal.status !== 'running' && removal.message === null) ? null : removal.status === 'running' ? 'running' : removal.status === 'error' || removal.partial ? 'failure' : 'result';
	// A result that lands while the surface is open shows for a few seconds; one from before it opened does not.
	const opened = useRef(removal);
	const [fresh, setFresh] = useState(false);
	useEffect(() => {
		if (removal === opened.current) return undefined;
		setFresh(true);
		const timer = setTimeout(() => setFresh(false), RESULT_FIRST_MS);
		return () => clearTimeout(timer);
	}, [removal]);
	const slotRef = useRef<HTMLDivElement>(null);
	const [inSlot, setInSlot] = useState({ focus: false, pointer: false });
	const showing = useRef<DocumentSlot>('empty');
	const slot = documentSlot({ write, fresh, held: inSlot.focus || inSlot.pointer, showing: showing.current });
	// What it shows changed: a control in it that left with the focus (Write details) hands the focus to the slot's
	// first control, else the document's; never the page.
	useBrowserLayoutEffect(() => {
		showing.current = slot;
		if (typeof document === 'undefined' || !inSlot.focus) return;
		const node = slotRef.current;
		if (focusLost(document.activeElement, document.body, null)) firstFocusable([node?.querySelector<HTMLElement>(TABBABLE) ?? null, returnFocus()])?.focus();
		const focus = !!node && node.contains(document.activeElement);
		setInSlot((was) => (was.focus === focus ? was : { ...was, focus }));
		// Only when what it shows changed.
	}, [slot]);
	return (
		<div
			ref={slotRef}
			style={styles.slot}
			data-document-write-slot=""
			onFocus={() => setInSlot((was) => (was.focus ? was : { ...was, focus: true }))}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInSlot((was) => ({ ...was, focus: false }));
			}}
			onPointerEnter={() => setInSlot((was) => ({ ...was, pointer: true }))}
			onPointerLeave={() => setInSlot((was) => ({ ...was, pointer: false }))}
		>
			{slot === 'write' && (
				<div style={styles.line} data-document-write-line="" title={removal.message ?? undefined}>
					{removal.status === 'error' ? (
						// Its own element, so a failure is announced as one.
						<div key="alert" role="alert" style={styles.text}>
							{removal.message}
						</div>
					) : (
						<div key="status" role="status" style={styles.text}>
							{removal.status === 'running' ? (removal.message ?? BUSY.removing) : removal.message}
						</div>
					)}
					{/* Outside the live element: opening it does not announce the line again. It opens above the line. */}
					{(removal.status === 'done' || removal.status === 'error') && <WriteAuditDetails message={removal.message} audit={removal.audit} />}
				</div>
			)}
		</div>
	);
}

export default DocumentWriteLine;
