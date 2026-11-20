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
// GRAPH-UI - STATUS LINE (the one line under the canvas)
// =============================================================================
//
// Left: what is true of the drawing (out of date, a notice, what is running, the
// budget, the layout, the selection), one item per kind (graph/statusLine.ts).
// Right: the result line the workbench passes in. Nothing floats over the
// canvas. A long text sits behind that item's "Details"; the out-of-date item
// also carries "Rerun" when the owner can run the query again.
//
// Only the most important item is on the line itself (with its Rerun and Details); the others are behind "N more".
// That keeps every button on the line visible, so none can be reached by Tab while clipped. Only one overlay is open.
//
// Information is announced politely (role="status"), an error assertively
// (role="alert"). The selection item is not announced: the canvas and the
// inspector already say what was selected.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button } from 'shell';
import type { IStatusItem } from '../graph/statusLine';

/** Props. */
export interface IGraphStatusLineProps {
	items: readonly IStatusItem[];
	/** The result line (rows, time), on the right. */
	meta?: ReactNode;
	/** Run the query again (offered on the out-of-date item). */
	onRerun?(): void;
}

const TONE: Record<IStatusItem['tone'], string> = { info: 'var(--rr-text-secondary)', warning: 'var(--rr-text-primary)', error: 'var(--rr-text-primary)' };
const MARK: Record<IStatusItem['tone'], string> = { info: '', warning: 'Warning: ', error: 'Error: ' };

const styles = {
	// One fixed line: a notice coming or going must never resize the canvas above it (the canvas would re-zoom).
	root: { position: 'relative', flex: '0 0 auto', height: 28, boxSizing: 'border-box', borderTop: '1px solid var(--rr-border)', fontSize: 12, padding: '0 10px', display: 'flex', alignItems: 'center' } as CSSProperties,
	row: { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', width: '100%', minWidth: 0 } as CSSProperties,
	left: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, flex: 1, whiteSpace: 'nowrap' } as CSSProperties,
	item: (tone: IStatusItem['tone']): CSSProperties => ({ display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0, flex: '0 1 auto', overflow: 'hidden', color: TONE[tone], fontWeight: tone === 'info' ? 400 : 600 }),
	text: { overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
	// Details float above the line, over the canvas, so opening them changes no height.
	details: { position: 'absolute', left: 0, right: 0, bottom: '100%', zIndex: 10, margin: 0, padding: '6px 10px', maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap', color: 'var(--rr-text-primary)', background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', boxShadow: '0 -2px 8px rgba(0,0,0,0.2)' } as CSSProperties,
	meta: { color: 'var(--rr-text-secondary)', whiteSpace: 'nowrap' } as CSSProperties,
};

/**
 * The status line.
 *
 * @param props - See {@link IGraphStatusLineProps}.
 * @returns The line.
 */
export const GraphStatusLine: React.FC<IGraphStatusLineProps> = ({ items, meta, onRerun }) => {
	// One overlay at a time: the first item's Details, or the other items.
	const [open, setOpen] = useState<'details' | 'more' | null>(null);
	const first = items[0];
	const rest = items.slice(1);
	if (!first) return <div style={styles.root} role="group" aria-label="Graph status" />;
	const toggle = (which: 'details' | 'more'): void => setOpen((before) => (before === which ? null : which));
	const live = first.kind === 'selection' ? {} : first.tone === 'error' ? { role: 'alert' as const } : { role: 'status' as const };
	return (
		<div style={styles.root} role="group" aria-label="Graph status">
			{open === 'details' && first.details !== null && <pre style={styles.details}>{first.details}</pre>}
			{open === 'more' && rest.length > 0 && (
				<div style={styles.details}>
					{rest.map((item) => (
						<div key={item.kind} style={{ marginBottom: 6, fontWeight: item.tone === 'info' ? 400 : 600 }}>
							<div>{`${MARK[item.tone]}${item.headline}`}</div>
							{item.details !== null && <div style={{ fontWeight: 400, opacity: 0.85 }}>{item.details}</div>}
						</div>
					))}
				</div>
			)}
			<div style={styles.row}>
				<div style={styles.left}>
					<span style={styles.item(first.tone)} {...live}>
						<span style={styles.text} title={first.headline}>{`${MARK[first.tone]}${first.headline}`}</span>
					</span>
					{first.kind === 'stale' && onRerun && <Button variant="ghost" small onClick={onRerun}>Rerun</Button>}
					{first.details !== null && <Button variant="ghost" small ariaExpanded={open === 'details'} onClick={() => toggle('details')}>Details</Button>}
					{rest.length > 0 && <Button variant="ghost" small ariaExpanded={open === 'more'} onClick={() => toggle('more')}>{`${rest.length} more`}</Button>}
				</div>
				{meta !== undefined && meta !== null && <div style={styles.meta}>{meta}</div>}
			</div>
		</div>
	);
};

export default GraphStatusLine;
