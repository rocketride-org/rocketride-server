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
// VECTOR-UI - INLINE REMOVE CONFIRMATION (in a dev-tool document, never a modal)
// =============================================================================
//
// The full app confirms a write with the shell's ConfirmDialog from one host
// at its root. A dev-tool document cannot: rocket-ui keeps hidden documents
// mounted (display: none), and a window-wide modal left open in a background
// document would trap Tab, lock the page scroll and take Escape for the whole
// realm (F14). So a frame shows the SAME confirmation (vector/confirm.ts: the
// words, the typed rule, Cancel first) as a panel inside its own document,
// with no overlay, no focus trap and no document or window listener: Cancel
// takes the focus when it opens, Escape cancels while the focus is inside it,
// and Confirm stays unavailable until the typed rule is met.
//
// It shows the pending confirmation of its connection's controller, which
// alone sends anything, on the surface that asked for it (its origin: the
// console, or one document tab of the full app, which shares the console's
// controller). Elsewhere it shows nothing, except to a surface that asked
// meanwhile: one line saying where the open one is.
//
// When it closes with the focus inside it, the focus goes to `onClosed`'s
// choice, else to `returnFocus` (the surface's fallback), and never stays on
// `<body>`.
// =============================================================================

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { Button, commonStyles } from 'shell';
import type { IProbeResult } from 'shared/explorer';
import type { IConnectionEntry } from '../adapters/connections';
import { CONSOLE_ORIGIN, confirmElsewhereText, confirmReady, confirmationFor, removeContextFor } from '../vector/confirm';
import type { ConfirmOrigin, ConfirmationView } from '../vector/confirm';
import { firstFocusable, focusLost } from '../vector/focus';
import { formatCount } from '../vector/stats';
import { styles as appStyles } from '../styles';

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
	/** Where the focus goes when the panel closes with the focus inside it, if `onClosed` did not move it. */
	returnFocus?: () => HTMLElement | null;
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
	const pending = useSyncExternalStore(entry.controller.subscribe, () => entry.controller.getState().confirm, () => null);
	const elsewhere = useSyncExternalStore(entry.controller.subscribe, () => entry.controller.getState().elsewhere, () => null);
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
	return <ConfirmPanel key={dialogKey} view={view} onConfirm={() => void entry.controller.confirmRemove()} onCancel={() => entry.controller.cancelRemove()} returnFocus={returnFocus} onClosed={onClosed} />;
}

/** One confirmation, keyed on what it confirms (a new one starts with an empty typed field and the focus on Cancel). */
const ConfirmPanel: React.FC<{ view: ConfirmationView; onConfirm(): void; onCancel(): void; returnFocus?: () => HTMLElement | null; onClosed?: (how: ConfirmClose) => void }> = ({ view, onConfirm: sendWrite, onCancel: dropWrite, returnFocus, onClosed }) => {
	const region = useRef<HTMLElement>(null);
	const actions = useRef<HTMLDivElement>(null);
	const [typed, setTyped] = useState('');
	const content = view.content;
	const ready = confirmReady(content.typed, typed);
	// The latest close handlers, for the unmount below.
	const how = useRef<ConfirmClose>('cancel');
	const closing = useRef({ returnFocus, onClosed });
	closing.current = { returnFocus, onClosed };
	// Opened: Cancel has the focus, so a stray Enter cancels (the dialogs' own rule).
	useEffect(() => {
		const cancel = Array.from(actions.current?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === content.cancelLabel);
		cancel?.focus();
		// Once, when the confirmation opens (it is keyed on what it confirms).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// Closed: the surface hears how; a focus left inside (or on the body) goes to the surface's fallback.
	useEffect(() => {
		const node = region.current;
		return () => {
			closing.current.onClosed?.(how.current);
			if (typeof document === 'undefined' || !focusLost(document.activeElement, document.body, node)) return;
			firstFocusable([closing.current.returnFocus?.()])?.focus();
		};
	}, []);
	const onConfirm = (): void => {
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
			<p style={styles.sentence}>{content.sentence}</p>
			{content.extra.map((sentence) => (
				<p key={sentence} style={styles.sentence}>
					{sentence}
				</p>
			))}
			{content.typed && (
				<label style={styles.typed}>
					<span>{content.typed.prompt}</span>
					<input type="text" value={typed} onChange={(event) => setTyped(event.target.value)} style={appStyles.input} autoComplete="off" spellCheck={false} />
				</label>
			)}
			<div ref={actions} style={styles.actions}>
				<Button variant="ghost" onClick={onCancel}>
					{content.cancelLabel}
				</Button>
				<button type="button" style={styles.confirm(content.destructive, ready)} aria-disabled={!ready} onClick={() => { if (ready) onConfirm(); }}>
					{content.confirmLabel}
				</button>
			</div>
		</section>
	);
};

export default InlineRemoveConfirm;
