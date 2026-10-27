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
// GRAPH-UI - SIDE PANEL (History and Saved, inline beside the tabs)
// =============================================================================
//
// A column at the right of a connection document, part of its own layout. Not a
// DetailPanel: rocket-ui keeps hidden documents mounted (display: none), and a
// modal drawer left open in a background document would trap Tab, lock the page
// scroll and take Escape for the whole realm. So this panel has no overlay, no
// focus trap and no document or window listener: it closes with its own button,
// or with Escape while the focus is inside it (and nothing inside used Escape).
//
// It takes the focus when it opens and gives it back to what opened it when it
// closes, as the connection details panel does.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { BxX, commonStyles } from 'shell';

/** Props. */
export interface ISidePanelProps {
	/** The panel's heading and accessible name. */
	title: string;
	subtitle?: string;
	/** Controls under the heading (History's "History | Saved" switch). */
	switcher?: React.ReactNode;
	onClose(): void;
	children: React.ReactNode;
}

const styles = {
	panel: { flex: '0 0 360px', maxWidth: '45%', minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)', outline: 'none' } as CSSProperties,
	header: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 8px 6px 16px' } as CSSProperties,
	heading: { flex: 1, minWidth: 0 } as CSSProperties,
	title: { ...commonStyles.textEllipsis, margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--rr-text-primary)' } as CSSProperties,
	subtitle: { ...commonStyles.textEllipsis, fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	close: commonStyles.paneHeaderButton,
	switcher: { padding: '0 16px 6px' } as CSSProperties,
	body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 16px 16px' } as CSSProperties,
};

/**
 * The panel.
 *
 * @param props - See {@link ISidePanelProps}.
 * @returns The aside.
 */
export const SidePanel: React.FC<ISidePanelProps> = ({ title, subtitle, switcher, onClose, children }) => {
	const region = useRef<HTMLElement>(null);

	// Opened: take the focus. Closed with the focus inside: give it back to what opened it, if that is still on the page.
	useEffect(() => {
		const node = region.current;
		const opener = document.activeElement;
		region.current?.focus();
		return () => {
			const focused = document.activeElement;
			const lost = focused === null || focused === document.body || (node !== null && node.contains(focused));
			if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	return (
		<aside
			ref={region}
			tabIndex={-1}
			aria-label={title}
			style={styles.panel}
			onKeyDown={(event) => {
				// Only a key pressed in the panel itself: a dialog it opened is rendered elsewhere in the page.
				if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
				event.preventDefault();
				onClose();
			}}
		>
			<div style={styles.header}>
				<div style={styles.heading}>
					<h2 style={styles.title}>{title}</h2>
					{subtitle && <div style={styles.subtitle}>{subtitle}</div>}
				</div>
				<button type="button" style={styles.close} title={`Close ${title}`} aria-label={`Close ${title}`} onClick={onClose}>
					<BxX size={18} />
				</button>
			</div>
			{switcher && <div style={styles.switcher}>{switcher}</div>}
			<div style={styles.body}>{children}</div>
		</aside>
	);
};

export default SidePanel;
