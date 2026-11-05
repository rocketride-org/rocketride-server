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
// GRAPH-UI - KEYS PANEL (the keyboard help, inline)
// =============================================================================
//
// The shortcuts of the graph view as a panel beside the canvas, not a dialog:
// rocket-ui keeps every document mounted, and a modal left open in a document
// nobody is looking at traps Tab and takes Escape for the whole window. This
// panel has no overlay, no focus trap and no listener on the document. It
// opens on an explicit request (the Keys button or "?") and then takes focus,
// so a screen reader hears it; Escape or Close ends it while focus is inside.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import { KEY_HELP } from '../graph/keynav';

/** Props. */
export interface IKeysPanelProps {
	onClose(): void;
	/** Increases each time the panel is opened by request; focus moves to the heading then. */
	focusToken: number;
}

const styles = {
	root: { borderTop: '1px solid var(--rr-border)', padding: '10px 12px', fontSize: 13 } as CSSProperties,
	head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } as CSSProperties,
	title: { margin: 0, fontSize: 14, outline: 'none' } as CSSProperties,
};

/**
 * The keys panel.
 *
 * @param props - See {@link IKeysPanelProps}.
 * @returns The panel.
 */
export const KeysPanel: React.FC<IKeysPanelProps> = ({ onClose, focusToken }) => {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, [focusToken]);
	return (
		<aside
			aria-label="Keyboard shortcuts"
			style={styles.root}
			onKeyDown={(event) => {
				if (event.key === 'Escape' && !event.defaultPrevented) {
					event.preventDefault();
					onClose();
				}
			}}
		>
			<div style={styles.head}>
				<h3 ref={heading} tabIndex={-1} style={styles.title}>Graph keyboard</h3>
				<Button variant="ghost" small onClick={onClose}>Close</Button>
			</div>
			<table style={{ borderCollapse: 'collapse' }}>
				<tbody>
					{KEY_HELP.map((row) => (
						<tr key={row.keys}>
							<th scope="row" style={{ textAlign: 'left', padding: '3px 12px 3px 0', verticalAlign: 'top' }}>{row.keys}</th>
							<td style={{ padding: '3px 0' }}>{row.does}</td>
						</tr>
					))}
				</tbody>
			</table>
		</aside>
	);
};

export default KeysPanel;
