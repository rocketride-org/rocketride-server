// MIT License
//
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
// DEBUG PANEL — ALT+D trace panel for shell events
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ConnectionManager } from '../../connection/connection';
import type { DebugLogEntry } from '../../connection/connection';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	panel: {
		width: 360,
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		borderLeft: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-surface)',
		fontFamily: 'var(--rr-font-family-mono, monospace)',
		fontSize: 11,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
		flexShrink: 0,
	} as CSSProperties,
	header: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '6px 10px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: 0.5,
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	} as CSSProperties,
	headerActions: {
		display: 'flex',
		gap: 6,
	} as CSSProperties,
	btn: {
		padding: '2px 8px',
		borderRadius: 3,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		fontSize: 10,
		cursor: 'pointer',
	} as CSSProperties,
	filterInput: {
		padding: '2px 6px',
		borderRadius: 3,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-primary)',
		fontSize: 10,
		width: 100,
		outline: 'none',
		fontFamily: 'var(--rr-font-family-mono, monospace)',
	} as CSSProperties,
	list: {
		flex: 1,
		overflowY: 'auto',
		padding: 0,
		margin: 0,
	} as CSSProperties,
	entry: {
		padding: '3px 10px',
		borderBottom: '1px solid var(--rr-border-subtle, rgba(128,128,128,0.1))',
		lineHeight: 1.5,
		wordBreak: 'break-all',
	} as CSSProperties,
	timestamp: {
		color: 'var(--rr-text-tertiary, #888)',
		marginRight: 6,
	} as CSSProperties,
	eventName: {
		color: 'var(--rr-brand, #4a9eff)',
		fontWeight: 600,
		marginRight: 6,
	} as CSSProperties,
	payload: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	empty: {
		padding: 20,
		textAlign: 'center',
		color: 'var(--rr-text-tertiary, #888)',
		fontSize: 11,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Debug trace panel that displays a live scrolling log of all shell events.
 *
 * The panel passively listens to the connectionManager wildcard handler and appends
 * new entries in real time.  It also captures iframe postMessage traffic via
 * a window `message` event listener.
 *
 * Features:
 * - Live auto-scrolling (locks to bottom unless user scrolls up)
 * - Text filter to narrow events by name
 * - Clear button to reset the log
 *
 * @param props.onClose - Callback to hide the debug panel (ALT+D toggle).
 */
const DebugPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
	const cm = ConnectionManager.getInstance();
	// Local copy of entries for rendering
	const [entries, setEntries] = useState<DebugLogEntry[]>(() => cm.getDebugLog());
	// Text filter for narrowing displayed events
	const [filter, setFilter] = useState('');
	// Ref for auto-scroll behaviour
	const listRef = useRef<HTMLDivElement>(null);
	// Track whether the user has scrolled away from bottom
	const isAtBottomRef = useRef(true);

	// --- Subscribe to wildcard events for real-time updates -------------------

	useEffect(() => {
		// Subscribe to all connectionManager events via wildcard
		const unsub = cm.onAny((event: string, payload: unknown) => {
			setEntries((prev) => {
				const entry: DebugLogEntry = {
					timestamp: new Date().toISOString(),
					event,
					payload,
				};
				// Trim to match the circular buffer size
				const next = [...prev, entry];
				if (next.length > 500) next.shift();
				return next;
			});
		});

		return unsub;
	}, []);

	// --- Capture iframe postMessage traffic -----------------------------------

	useEffect(() => {
		/**
		 * Listens for all window message events and logs them as debug entries
		 * with the 'postMessage' event name.
		 */
		const handler = (e: MessageEvent) => {
			// Only log structured messages that look like shell protocol
			if (!e.data || typeof e.data !== 'object' || !e.data.type) return;
			setEntries((prev) => {
				const entry: DebugLogEntry = {
					timestamp: new Date().toISOString(),
					event: `postMessage:${e.data.type}`,
					payload: e.data,
				};
				const next = [...prev, entry];
				if (next.length > 500) next.shift();
				return next;
			});
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	// --- Auto-scroll to bottom -----------------------------------------------

	useEffect(() => {
		if (isAtBottomRef.current && listRef.current) {
			listRef.current.scrollTop = listRef.current.scrollHeight;
		}
	}, [entries]);

	/**
	 * Tracks scroll position to determine if auto-scroll should be active.
	 * Auto-scroll is active when the user is scrolled to within 20px of bottom.
	 */
	const handleScroll = useCallback(() => {
		const el = listRef.current;
		if (!el) return;
		isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
	}, []);

	// --- Clear handler -------------------------------------------------------

	/**
	 * Clears both the module-level debug log and the local display state.
	 */
	const handleClear = useCallback(() => {
		cm.clearDebugLog();
		setEntries([]);
	}, []);

	// --- Filter entries ------------------------------------------------------

	const displayed = filter
		? entries.filter((e) => e.event.toLowerCase().includes(filter.toLowerCase()))
		: entries;

	// --- Render --------------------------------------------------------------

	return (
		<div style={styles.panel}>
			<div style={styles.header}>
				<span>Debug</span>
				<div style={styles.headerActions}>
					<input
						style={styles.filterInput}
						placeholder="Filter..."
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
					<button style={styles.btn} onClick={handleClear}>Clear</button>
					<button style={styles.btn} onClick={onClose}>×</button>
				</div>
			</div>

			<div ref={listRef} style={styles.list} onScroll={handleScroll}>
				{displayed.length === 0 ? (
					<div style={styles.empty}>No events captured</div>
				) : displayed.map((entry, i) => {
					// Format timestamp as HH:MM:SS.mmm for compact display
					const time = entry.timestamp.slice(11, 23);
					// Compact payload preview
					let payloadStr: string;
					try {
						payloadStr = JSON.stringify(entry.payload);
						if (payloadStr && payloadStr.length > 120) {
							payloadStr = payloadStr.slice(0, 120) + '…';
						}
					} catch {
						payloadStr = '[unserializable]';
					}

					return (
						<div key={i} style={styles.entry}>
							<span style={styles.timestamp}>{time}</span>
							<span style={styles.eventName}>{entry.event}</span>
							<span style={styles.payload}>{payloadStr}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
};

export default DebugPanel;
