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
// VECTOR-UI - INLINE REMOVE CONFIRMATION (in the workbench and a document, never a modal)
// =============================================================================
//
// rocket-ui keeps hidden documents mounted (display: none), and a
// window-wide modal left open in a background document would trap Tab, lock
// the page scroll and take Escape for the whole realm (F14). So every write
// is confirmed by this panel inside its own document, in both mounts (D10),
// with the words and the typed rule of vector/confirm.ts, no overlay, no
// focus trap and no document or window listener. When it opens the focus
// goes by the write's weight (vector/confirm.ts confirmFirstFocus): Confirm
// for one that can be undone (Move to trash), but Cancel for a bulk move
// (over 100 documents, or over one store batch), so a stray Enter does not
// move them all; for one that cannot (Delete permanently, Empty trash) the
// typed field, else Cancel, never the destructive button. Escape cancels while the
// focus is inside it (unless an inner handler already acted), and Confirm
// stays unavailable (aria-disabled, so it keeps the focus) until the typed
// rule is met. Enter in the typed field confirms once it matches; before
// that the field's hint says it does not match yet.
//
// It shows the pending confirmation of its connection's controller, which
// alone sends anything, on the surface that asked for it (its origin: the
// console, or one document tab of the full app, which shares the console's
// controller). Elsewhere it shows nothing, except to a surface that asked
// meanwhile: one line saying where the open one is.
//
// When it closes with the focus inside it (or lost), the focus goes where
// `onClosed` put it; else, after Cancel, back to what had it when the panel
// opened; else to `returnFocus` (the surface's fallback: in the workbench,
// the row its grid marks after the rows the write takes away, else the
// grid, else the tab); else to the first target of the surface it sits on
// (components/focusTargets.ts surfaceTarget), so a caller that names none
// still never leaves the focus on `<body>`. Never an element of a hidden panel.
// =============================================================================

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { Button, commonStyles } from 'shell';
import type { IProbeResult } from 'shared/explorer';
import type { IConnectionEntry } from '../adapters/connections';
import { CONSOLE_ORIGIN, confirmElsewhereText, confirmFirstFocus, confirmReady, confirmationFor, removeContextFor, typedHint } from '../vector/confirm';
import type { ConfirmFirstFocus, ConfirmOrigin, ConfirmationView } from '../vector/confirm';
import { firstFocusable, focusLost } from '../vector/focus';
import { formatCount } from '../vector/stats';
import { FOCUS_RING, styles as appStyles } from '../styles';
import { surfaceOf, surfaceTarget } from './focusTargets';

const styles = {
	panel: {
		flexShrink: 0,
		margin: '12px 24px 0',
		padding: '12px 16px',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		background: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-primary)',
		outline: 'none',
	} as CSSProperties,
	title: {
		...commonStyles.textEllipsis,
		margin: 0,
		fontSize: 14,
		fontWeight: 600,
	} as CSSProperties,
	lines: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: '8px 0', fontSize: 13 } as CSSProperties,
	term: { fontWeight: 600 } as CSSProperties,
	value: { margin: 0, overflowWrap: 'anywhere' } as CSSProperties,
	list: { margin: '8px 0', paddingLeft: 20, maxHeight: 180, overflowY: 'auto', fontSize: 13 } as CSSProperties,
	item: { overflowWrap: 'anywhere' } as CSSProperties,
	sentence: { margin: '8px 0', fontSize: 13 } as CSSProperties,
	elsewhere: { flexShrink: 0, margin: '8px 24px 0', fontSize: 13 } as CSSProperties,
	typed: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, fontSize: 13 } as CSSProperties,
	actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 } as CSSProperties,
	/** Confirm: destructive for a permanent write; unavailable (aria-disabled, it keeps the focus) until the typed rule is met. */
	confirm: (destructive: boolean, ready: boolean): CSSProperties => ({ ...(destructive ? commonStyles.buttonDanger : commonStyles.buttonPrimary), ...(ready ? null : commonStyles.buttonDisabled) }),
};

/** How a confirmation closed: Confirm sent the write, or it was cancelled (Cancel, Escape, writes switched off). */
export type ConfirmClose = 'confirm' | 'cancel';

/** Props. */
export interface IInlineRemoveConfirmProps {
	/** The connection's objects (their controller holds the pending write). */
	entry: IConnectionEntry;
	/** The connection's probe (where the documents are removed from). */
	probe: IProbeResult | undefined;
	/** The surface this renders on: it shows only the confirmations asked for here (default the console). */
	origin?: ConfirmOrigin;
	/**
	 * Where the focus goes when the panel closes with the focus inside it, if `onClosed` did not move it (and, after
	 * Cancel, the opener cannot take it back).
	 */
	returnFocus?: (opener: HTMLElement | null) => HTMLElement | null;
	/** Told when the panel closes, before the focus falls back to `returnFocus`. */
	onClosed?: (how: ConfirmClose) => void;
}

/**
 * The pending confirmation of a connection, inline, on the surface that asked for it.
 *
 * @param props - See {@link IInlineRemoveConfirmProps}.
 * @returns The panel; the "open elsewhere" line for a surface that asked meanwhile; or nothing.
 */
export function InlineRemoveConfirm({ entry, probe, origin = CONSOLE_ORIGIN, returnFocus, onClosed }: IInlineRemoveConfirmProps): React.ReactElement | null {
	const pending = useSyncExternalStore(entry.controller.subscribe, () => entry.controller.getState().confirm, () => entry.controller.getState().confirm);
	const elsewhere = useSyncExternalStore(entry.controller.subscribe, () => entry.controller.getState().elsewhere, () => entry.controller.getState().elsewhere);
	if (pending === null) return null;
	if (pending.origin !== origin) {
		return elsewhere === origin ? (
			<p role="status" data-confirm-elsewhere="" style={styles.elsewhere}>
				{confirmElsewhereText(pending.origin)}
			</p>
		) : null;
	}
	const view = confirmationFor(pending, removeContextFor(entry.ctx.endpoint, probe));
	const dialogKey = `${pending.action}:${pending.targets.length}:${pending.targets[0]?.objectId ?? ''}`;
	const first = confirmFirstFocus(pending.action, pending.targets.length, entry.ctx.limits.write_ids_max);
	return <ConfirmPanel key={dialogKey} view={view} first={first} onConfirm={() => void entry.controller.confirmRemove()} onCancel={() => entry.controller.cancelRemove()} returnFocus={returnFocus} onClosed={onClosed} />;
}

/** One confirmation, keyed on what it confirms (a new one starts with an empty typed field and its own first focus). */
const ConfirmPanel: React.FC<{ view: ConfirmationView; first: ConfirmFirstFocus; onConfirm(): void; onCancel(): void; returnFocus?: (opener: HTMLElement | null) => HTMLElement | null; onClosed?: (how: ConfirmClose) => void }> = ({ view, first, onConfirm: sendWrite, onCancel: dropWrite, returnFocus, onClosed }) => {
	const region = useRef<HTMLElement>(null);
	const actions = useRef<HTMLDivElement>(null);
	const confirmButton = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const sentenceId = useId();
	const pathId = useId();
	// What had the focus when the confirmation opened (before Cancel takes it): Cancel gives it back.
	const opener = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const [typed, setTyped] = useState('');
	// Enter was pressed in the typed field before it matched: the hint says so until the text changes.
	const [nudged, setNudged] = useState(false);
	const content = view.content;
	const ready = confirmReady(content.typed, typed);
	// One document typed by its file name: its whole path beside the field (a file name can repeat across folders).
	const typedPath = view.kind === 'single' && content.typed ? (view.content.lines.find((line) => line.label === 'Path')?.value ?? null) : null;
	// The latest close handlers, for the unmount below.
	const how = useRef<ConfirmClose>('cancel');
	const closing = useRef({ returnFocus, onClosed });
	closing.current = { returnFocus, onClosed };
	// Opened: the first focus by the write's weight (vector/confirm.ts confirmFirstFocus; never the destructive button).
	useEffect(() => {
		if (first === 'confirm') confirmButton.current?.focus();
		else if (first === 'typed' && content.typed) input.current?.focus();
		else Array.from(actions.current?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === content.cancelLabel)?.focus();
		// Once, when the confirmation opens (it is keyed on what it confirms).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// Closed: the surface hears how; a focus left inside (or on the body) goes to the surface's fallback.
	useEffect(() => {
		const node = region.current;
		const back = opener.current;
		// The surface it sits on (read while it is on the page): its own fallback when the caller named none.
		const surface = surfaceOf(node);
		return () => {
			closing.current.onClosed?.(how.current);
			if (typeof document === 'undefined' || !focusLost(document.activeElement, document.body, node)) return;
			// The caller's fallback is told the opener: a document surface puts the focus back there after Confirm too.
			firstFocusable([how.current === 'cancel' ? back : null, closing.current.returnFocus?.(back), surfaceTarget(surface)])?.focus();
		};
	}, []);
	const onConfirm = (): void => {
		if (!ready) return;
		how.current = 'confirm';
		sendWrite();
	};
	const onCancel = (): void => {
		how.current = 'cancel';
		dropWrite();
	};
	return (
		<section
			ref={region}
			role="group"
			aria-label={content.title}
			data-inline-confirm=""
			style={styles.panel}
			onKeyDown={(event) => {
				if (event.defaultPrevented) return;
				if (event.key === 'Escape') {
					event.preventDefault();
					onCancel();
				}
			}}
		>
			<h2 style={styles.title}>{content.title}</h2>
			{view.kind === 'single' ? (
				<dl style={styles.lines}>
					{view.content.lines.map((line) => (
						<React.Fragment key={line.label}>
							<dt style={styles.term}>{line.label}</dt>
							<dd style={styles.value}>{line.value}</dd>
						</React.Fragment>
					))}
				</dl>
			) : (
				<>
					<ul aria-label={view.content.listLabel} style={styles.list}>
						{view.content.listed.map((path, i) => (
							<li key={`${i}:${path}`} style={styles.item}>
								{path}
							</li>
						))}
					</ul>
					{view.content.more > 0 && <p style={styles.sentence}>{`and ${formatCount(view.content.more)} more`}</p>}
				</>
			)}
			<p id={sentenceId} style={styles.sentence}>
				{content.sentence}
			</p>
			{content.extra.map((sentence) => (
				<p key={sentence} style={styles.sentence}>
					{sentence}
				</p>
			))}
			{content.typed && (
				<label style={styles.typed}>
					<span aria-live="polite">{typedHint(content.typed, typed, nudged)}</span>
					{typedPath !== null && <span id={pathId}>{`Full path: ${typedPath}`}</span>}
					<input
						ref={input}
						type="text"
						value={typed}
						onChange={(event) => {
							setTyped(event.target.value);
							setNudged(false);
						}}
						onKeyDown={(event) => {
							// Enter confirms once the typed text matches; before that the hint says what is missing.
							if (event.defaultPrevented || event.key !== 'Enter') return;
							event.preventDefault();
							if (ready) onConfirm();
							else setNudged(true);
						}}
						style={appStyles.input}
						autoComplete="off"
						spellCheck={false}
						aria-describedby={typedPath !== null ? `${sentenceId} ${pathId}` : sentenceId}
						onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)}
						onBlur={(event) => (event.currentTarget.style.outline = 'none')}
					/>
				</label>
			)}
			<div ref={actions} style={styles.actions}>
				<Button variant="ghost" onClick={onCancel}>
					{content.cancelLabel}
				</Button>
				<button ref={confirmButton} type="button" style={styles.confirm(content.destructive, ready)} aria-disabled={!ready} onClick={onConfirm} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
					{content.confirmLabel}
				</button>
			</div>
		</section>
	);
};

export default InlineRemoveConfirm;
