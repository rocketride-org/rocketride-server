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
// VECTOR-UI - WRITE AUDIT DETAILS (the store's audit of the last write, behind a disclosure)
// =============================================================================
//
// soft_delete, restore and delete answer with an `audit` block per batch:
// the tool, the rows it touched and who called (vector/results.ts
// readAudit; never content or vectors). The console keeps them with the
// write's result (removal.audit), and this disclosure, at the right end of
// the hub's bottom line (outside its announced text), shows the result's
// whole sentence first (the line is one line and cuts it: the documents kept
// whole, those already gone, where it stopped), then the audit, one line per
// batch (vector/confirm.ts auditLines). Its summary is "Write details", not
// the header's "Details" (the connection's).
//
// The list opens over the panel, never growing the line: placed before the
// browser paints by the map popovers' rules (map/popover.ts placePopover:
// above the line at its summary, inside the window, any clipping
// ancestor and the surface it sits on, so never under the sidebar), and
// closed like them: Escape (focus back on the summary), a press outside it,
// or a resize of the window or of its line.
// Nothing shows while there is neither a sentence nor an audit.
// =============================================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { POPOVER_GAP, clipArea, placePopover, popoverKey } from '../map/popover';
import type { IPopoverAnchor } from '../map/popover';
import { auditLines } from '../vector/confirm';
import type { IWriteAudit } from '../vector/results';
import { styles as appStyles } from '../styles';

/** The panel's own caps: the sentence and a few lines of the store's audit. */
const LIST_MAX = { width: 480, height: 200 };

const styles = {
	details: { ...appStyles.small, position: 'relative', display: 'inline-block', flexShrink: 0 } as CSSProperties,
	summary: { cursor: 'pointer', whiteSpace: 'nowrap' } as CSSProperties,
	/** Over what is above the line: the line it sits on keeps its height. Before it is placed: up, ending at the summary. */
	list: { position: 'absolute', zIndex: 20, boxSizing: 'border-box', width: 'max-content', maxWidth: LIST_MAX.width, maxHeight: LIST_MAX.height, overflowY: 'auto', margin: 0, padding: '6px 10px', border: '1px solid var(--rr-border)', borderRadius: 6, background: 'var(--rr-bg-paper)', boxShadow: 'var(--rr-shadow-widget)', whiteSpace: 'normal', overflowWrap: 'anywhere' } as CSSProperties,
	result: { margin: 0 } as CSSProperties,
	lines: { margin: '4px 0 0', paddingLeft: 16 } as CSSProperties,
	unplaced: { bottom: `calc(100% + ${POPOVER_GAP}px)`, right: 0 } as CSSProperties,
};

const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

/** Where the list goes, relative to the disclosure, and its caps. */
interface IListPlace {
	left: number;
	top: number;
	maxWidth: number;
	maxHeight: number;
}

/**
 * The rectangles of the ancestors that clip what overflows them.
 *
 * @param el - Where to start (its parent first).
 * @returns Their rectangles.
 */
function clippingRects(el: HTMLElement): IPopoverAnchor[] {
	const out: IPopoverAnchor[] = [];
	for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
		const style = getComputedStyle(node);
		if (style.overflowX !== 'visible' || style.overflowY !== 'visible') out.push(node.getBoundingClientRect());
	}
	return out;
}

/** Props for the {@link WriteAuditDetails} component. */
export interface IWriteAuditDetailsProps {
	/** The last write's audit blocks (IConsoleState.removal.audit). */
	audit: readonly IWriteAudit[] | undefined;
	/** The result's whole sentence, shown first (the line it sits on may cut it). */
	result?: string;
	/** The disclosure's summary (default {@link WRITE_DETAILS_LABEL}). */
	label?: string;
}

/** The disclosure's summary: not "Details", which is the header's button for the connection. */
export const WRITE_DETAILS_LABEL = 'Write details';

/**
 * The audit of the last write, behind a "Write details" disclosure.
 *
 * @param props - {@link IWriteAuditDetailsProps}.
 * @returns The disclosure, or nothing without an audit.
 */
export function WriteAuditDetails({ audit, result, label = WRITE_DETAILS_LABEL }: IWriteAuditDetailsProps): React.ReactElement | null {
	if ((!audit || audit.length === 0) && !result) return null;
	return <AuditDisclosure audit={audit ?? []} result={result} label={label} />;
}

/** The disclosure itself: open over the panel, closed by Escape, a press outside it or a resize. */
const AuditDisclosure: React.FC<{ audit: readonly IWriteAudit[]; result: string | undefined; label: string }> = ({ audit, result, label }) => {
	const details = useRef<HTMLDetailsElement>(null);
	const summary = useRef<HTMLElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [place, setPlace] = useState<IListPlace | null>(null);
	// Closing hides the list: the focus it held (a scrolling list can take it) goes back to the summary.
	const close = (refocus: boolean): void => {
		const back = refocus || (typeof document !== 'undefined' && !!list.current?.contains(document.activeElement));
		setOpen(false);
		if (back) summary.current?.focus();
	};
	const closing = useRef(close);
	closing.current = close;

	// Measured before paint on every render while open, set only when it moved.
	useBrowserLayoutEffect(() => {
		if (!open) {
			if (place !== null) setPlace(null);
			return;
		}
		const node = details.current;
		const button = summary.current;
		const panel = list.current;
		if (!node || !button || !panel || typeof window === 'undefined') return;
		// The window, cut down by what clips it and by the surface it sits on (the workbench, a document).
		const surface = node.closest<HTMLElement>('[data-console], [data-document]');
		const area = clipArea({ width: window.innerWidth, height: window.innerHeight }, [...clippingRects(node), ...(surface ? [surface.getBoundingClientRect()] : [])]);
		const size = { width: Math.min(panel.offsetWidth, LIST_MAX.width), height: Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, LIST_MAX.height) };
		// Across from the summary, above or below its whole line (never over the line's words).
		const across = button.getBoundingClientRect();
		const line = node.parentElement?.getBoundingClientRect() ?? across;
		const at = placePopover({ left: across.left, right: across.right, top: Math.min(line.top, across.top), bottom: Math.max(line.bottom, across.bottom) }, size, area);
		const origin = node.getBoundingClientRect();
		const next = { left: Math.round(at.left - origin.left), top: Math.round(at.top - origin.top), maxWidth: Math.floor(Math.min(at.maxWidth, LIST_MAX.width)), maxHeight: Math.floor(Math.min(at.maxHeight, LIST_MAX.height)) };
		if (place === null || place.left !== next.left || place.top !== next.top || place.maxWidth !== next.maxWidth || place.maxHeight !== next.maxHeight) setPlace(next);
	});

	useEffect(() => {
		if (!open || typeof window === 'undefined') return undefined;
		const onResize = (): void => closing.current(false);
		const onDown = (event: PointerEvent): void => {
			const node = details.current;
			if (node && event.target instanceof Node && !node.contains(event.target)) closing.current(false);
		};
		window.addEventListener('resize', onResize);
		document.addEventListener('pointerdown', onDown);
		// Its line resized without the window (a split pane): the place is stale, so close the same way.
		const line = details.current?.parentElement ?? null;
		let width: number | null = null;
		const observer =
			line && typeof ResizeObserver !== 'undefined'
				? new ResizeObserver((entries) => {
						const next = Math.round(entries[0]?.contentRect.width ?? 0);
						if (width === null) width = next;
						else if (next !== width) closing.current(false);
					})
				: null;
		if (observer && line) observer.observe(line);
		return () => {
			window.removeEventListener('resize', onResize);
			document.removeEventListener('pointerdown', onDown);
			observer?.disconnect();
		};
	}, [open]);

	const onKeyDown = (event: React.KeyboardEvent): void => {
		const key = popoverKey(event.key, event.defaultPrevented);
		if (!open || !key.close) return;
		event.preventDefault();
		close(key.refocus);
	};
	return (
		<details ref={details} open={open} style={styles.details} data-write-audit="" onKeyDown={onKeyDown}>
			<summary
				ref={summary}
				style={styles.summary}
				onClick={(event) => {
					// The open state is React's, so the list is placed before it is painted.
					event.preventDefault();
					setOpen((was) => !was);
				}}
			>
				{label}
			</summary>
			<div ref={list} style={{ ...styles.list, ...(place === null ? styles.unplaced : place) }} data-write-audit-list="">
				{result && <p style={styles.result}>{result}</p>}
				{audit.length > 0 && (
					<ul aria-label="What the store recorded for this write" style={result ? styles.lines : { ...styles.lines, marginTop: 0 }}>
						{auditLines(audit).map((line, i) => (
							<li key={`${i}:${line}`}>{line}</li>
						))}
					</ul>
				)}
			</div>
		</details>
	);
};

export default WriteAuditDetails;
