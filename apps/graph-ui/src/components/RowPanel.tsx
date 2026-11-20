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
// GRAPH-UI - ROW PANEL (one Table row in full, beside the results)
// =============================================================================
//
// A grid cell truncates; this shows one row's values whole, with "Copy row as
// JSON". It replaces the shared Explorer's row drawer in the workbench: that one
// is a DetailPanel, which listens for Escape on the whole page, and with query
// tabs it would sit open in a hidden tab (or a hidden document, which rocket-ui
// keeps mounted) and take Escape from whatever is in front. This one is part of
// the run surface's own layout (SidePanel: no overlay, no page listener), and the
// surface closes it when its tab is hidden.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import type { IRowView } from '../graph/rowInspect';
import { CopyBlocked, copyText } from './ResultViews';
import SidePanel from './SidePanel';

/** Props. */
export interface IRowPanelProps {
	/** e.g. "Row 3 of 25". */
	title: string;
	subtitle: string;
	view: IRowView;
	announce(text: string): void;
	onClose(): void;
}

const styles = {
	list: { margin: 0 } as CSSProperties,
	label: { fontSize: 12, fontWeight: 600, color: 'var(--rr-text-secondary)', marginTop: 10 } as CSSProperties,
	value: { margin: '2px 0 0', fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as CSSProperties,
	actions: { margin: '4px 0 8px' } as CSSProperties,
	note: { fontSize: 11.5, color: 'var(--rr-text-secondary)', marginTop: 12 } as CSSProperties,
};

/**
 * The panel.
 *
 * @param props - See {@link IRowPanelProps}.
 * @returns The aside.
 */
export const RowPanel: React.FC<IRowPanelProps> = ({ title, subtitle, view, announce, onClose }) => {
	// Where the clipboard is not allowed (some editor panels), the JSON is offered to select by hand.
	const [blocked, setBlocked] = useState(false);
	return (
		<SidePanel title={title} subtitle={subtitle} onClose={onClose}>
			<div style={styles.actions}>
				<Button
					variant="ghost"
					small
					onClick={() => {
						void copyText(view.json).then((ok) => {
							setBlocked(!ok);
							announce(ok ? 'Copied the row as JSON.' : 'Copying is not allowed here; the JSON is shown to copy by hand.');
						});
					}}
				>
					Copy row as JSON
				</Button>
			</div>
			{blocked && <CopyBlocked text={view.json} />}
			<dl style={styles.list}>
				{view.fields.map((field, index) => (
					<React.Fragment key={index}>
						<dt style={styles.label}>{field.label}</dt>
						<dd style={{ margin: 0 }}>
							<pre style={styles.value}>{field.value}</pre>
						</dd>
					</React.Fragment>
				))}
			</dl>
			<div style={styles.note}>{view.note}</div>
		</SidePanel>
	);
};

export default RowPanel;
