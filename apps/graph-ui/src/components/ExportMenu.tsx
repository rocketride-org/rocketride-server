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
// GRAPH-UI - EXPORT MENU (the results card's Export button)
// =============================================================================
//
// "Export" on the Table and Raw cards: CSV and JSON of the rows the query returned
// (graph/exportRows.ts, built from the result and never from the grid). They
// download; in VS Code, which refuses downloads from a tool panel, the same items
// say Copy and put the text on the clipboard. The menu opens in a shell popup
// anchored to the button: no modal, no document key listener of our own.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AnchoredPopup, Button, commonStyles, isInVSCode } from 'shell';
import { CSV_FORMULA_NOTE, MAX_COPY_CHARS, browserCopy, browserDownload, deliverExport, exportFileName, exportNote, exportResult } from '../graph/exportRows';
import type { ExportFormat } from '../graph/exportRows';
import type { ReadQueryResult } from '../graph/types';

/** How long the outcome stays beside the button. */
const STATUS_MS = 5000;

const styles = {
	popup: { ...commonStyles.popupMenu, minWidth: 200 } as CSSProperties,
	items: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2 } as CSSProperties,
	note: { fontSize: 11, color: 'var(--rr-text-secondary)', padding: '4px 8px', maxWidth: 260 } as CSSProperties,
	status: { fontSize: 11, color: 'var(--rr-text-secondary)' } as CSSProperties,
};

/** Props. */
export interface IExportMenuProps {
	result: ReadQueryResult;
	/** The polite live region; the menu also shows the outcome beside its button. */
	announce?(text: string): void;
}

/**
 * Move focus between a menu's buttons with the arrow keys, Home and End.
 *
 * @param event - The key event on the menu's container.
 */
function moveFocus(event: React.KeyboardEvent<HTMLElement>): void {
	const items = Array.from(event.currentTarget.querySelectorAll('button'));
	const at = items.indexOf(document.activeElement as HTMLButtonElement);
	let target: number | null = null;
	if (event.key === 'ArrowDown') target = at < 0 ? 0 : (at + 1) % items.length;
	else if (event.key === 'ArrowUp') target = at <= 0 ? items.length - 1 : at - 1;
	else if (event.key === 'Home') target = 0;
	else if (event.key === 'End') target = items.length - 1;
	if (target === null || items.length === 0) return;
	event.preventDefault();
	items[target].focus();
}

/**
 * A key pressed inside the menu. Escape is the menu's own while it is open: it is claimed (`preventDefault`, so nothing
 * above the portal, a full screen or another panel, also acts on it), the menu closes, and focus goes back to the
 * Export button. Other keys move between the items.
 *
 * @param event - The key event (only what is read).
 * @param actions - What the menu can do.
 */
export function handleMenuKey(event: { key: string; preventDefault(): void }, actions: { close(): void; focusButton(): void; move(): void }): void {
	if (event.key === 'Escape') {
		event.preventDefault();
		actions.close();
		actions.focusButton();
	} else {
		actions.move();
	}
}

/**
 * The Export button and its menu.
 *
 * @param props - See {@link IExportMenuProps}.
 * @returns The button, its popup and the outcome text.
 */
export const ExportMenu: React.FC<IExportMenuProps> = ({ result, announce }) => {
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState('');
	const anchor = useRef<HTMLSpanElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	// A VS Code webview refuses downloads, so there an export is copied.
	const copies = isInVSCode();

	useEffect(() => {
		if (!open) return undefined;
		const frame = requestAnimationFrame(() => menu.current?.querySelector('button')?.focus());
		return () => cancelAnimationFrame(frame);
	}, [open]);
	useEffect(() => {
		if (!status) return undefined;
		const timer = setTimeout(() => setStatus(''), STATUS_MS);
		return () => clearTimeout(timer);
	}, [status]);

	const run = useCallback(
		(format: ExportFormat) => {
			setOpen(false);
			anchor.current?.querySelector('button')?.focus();
			const rows = result.rows.length;
			const what = `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'} as ${format === 'csv' ? 'CSV' : 'JSON'}`;
			const payload = { ...exportResult(format, result), fileName: exportFileName(Date.now(), format) };
			void deliverExport(payload, { downloadsRefused: copies, download: browserDownload, copy: browserCopy }).then((outcome) => {
				// A page that blocks downloads quietly cannot be told apart, so this says the download started.
				const text = outcome === 'downloaded' ? `Download started: ${what}.` : outcome === 'copied' ? `Copied ${what} to the clipboard.` : outcome === 'too-large' ? `Not copied: ${what} is too large for the clipboard (over ${MAX_COPY_CHARS.toLocaleString('en-US')} characters). Lower the row limit, or export where downloads are allowed.` : `Could not export ${what}: the browser refused.`;
				setStatus(text);
				announce?.(text);
			});
		},
		[result, copies, announce]
	);

	return (
		<>
			{status && <span role="status" style={styles.status}>{status}</span>}
			<span ref={anchor}>
				<Button variant="secondary" small ariaExpanded={open} title="Export the rows this query returned" onClick={() => setOpen((v) => !v)}>
					Export
				</Button>
			</span>
			<AnchoredPopup anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="end" style={styles.popup}>
				<div
					ref={menu}
					role="group"
					aria-label="Export"
					style={styles.items}
					onKeyDown={(event) => handleMenuKey(event, { close: () => setOpen(false), focusButton: () => anchor.current?.querySelector('button')?.focus(), move: () => moveFocus(event) })}
				>
					<div style={styles.note}>{exportNote(result)}</div>
					<Button variant="ghost" small onClick={() => run('csv')}>{copies ? 'Copy as CSV' : 'Download CSV'}</Button>
					<Button variant="ghost" small onClick={() => run('json')}>{copies ? 'Copy as JSON' : 'Download JSON'}</Button>
					<div style={styles.note}>{CSV_FORMULA_NOTE}</div>
				</div>
			</AnchoredPopup>
		</>
	);
};

export default ExportMenu;
