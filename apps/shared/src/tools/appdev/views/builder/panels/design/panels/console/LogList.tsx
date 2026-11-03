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
// LOG LIST — shared mono list for the Events / Console / Errors panes
// =============================================================================

/**
 * A filterable, capped, mono-typeface log list used by all three DEVELOP
 * feed panes. Rows arrive pre-rendered as `{time, accent, detail}` triples
 * so one component serves events (name + payload), console (level + text),
 * and errors (message + source). Renders a teaching empty state when there
 * are no rows at all, distinct from "filter matched nothing".
 */

import React, { useMemo, useState } from 'react';
import { EmptyState } from 'shell';
import { InputField } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

/** One rendered log row. */
export interface LogListRow {
	/** Rendered timestamp ("09:12:11"). */
	time: string;
	/** The accented token (event name / console level / error marker). */
	accent: string;
	/** Accent colour token (defaults to the events purple). */
	accentColor?: string;
	/** Dim detail text (payload / line / message). */
	detail?: string;
}

/** Props for the {@link LogList} component. */
export interface ILogListProps {
	/** Rows, oldest first (the list renders in order given). */
	rows: LogListRow[];
	/** Teaching empty-state title when there are no rows at all. */
	emptyTitle: string;
	/** Teaching empty-state description. */
	emptyDescription: string;
}

// Cap the retained render set — feeds are unbounded streams.
export const LOG_LIST_CAP = 1000;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
	},
	filterRow: {
		padding: '8px 14px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	},
	list: {
		flex: 1,
		overflow: 'auto',
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11.5,
		lineHeight: 1.8,
		padding: '10px 16px',
	},
	row: {
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	},
	time: {
		color: 'var(--rr-text-disabled)',
		marginRight: 8,
	},
	detail: {
		color: 'var(--rr-text-secondary)',
		marginLeft: 8,
	},
	emptyWrap: {
		padding: 26,
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the shared log list: a filter input over a capped mono list.
 *
 * @param props - See {@link ILogListProps}.
 */
export const LogList: React.FC<ILogListProps> = ({ rows, emptyTitle, emptyDescription }) => {
	// Case-insensitive substring filter over accent + detail
	const [filter, setFilter] = useState('');

	// Cap first (keep the newest), then filter what remains
	const visible = useMemo(() => {
		const capped = rows.length > LOG_LIST_CAP ? rows.slice(rows.length - LOG_LIST_CAP) : rows;
		const needle = filter.trim().toLowerCase();
		if (!needle) return capped;
		return capped.filter((r) =>
			r.accent.toLowerCase().includes(needle) || (r.detail ?? '').toLowerCase().includes(needle));
	}, [rows, filter]);

	// No rows at all: the teaching empty state (no filter box — nothing to filter)
	if (rows.length === 0) {
		return (
			<div style={styles.emptyWrap}>
				<EmptyState title={emptyTitle} description={emptyDescription} />
			</div>
		);
	}

	return (
		<div style={styles.wrap}>
			<div style={styles.filterRow}>
				<InputField
					placeholder="Filter…"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
				/>
			</div>
			<div style={styles.list}>
				{visible.map((r, i) => (
					// Rows have no stable identity (append-only stream) — index
					// keying is correct here; the list only ever appends/trims.
					<div key={i} style={styles.row}>
						<span style={styles.time}>{r.time}</span>
						<span style={{ color: r.accentColor ?? '#8250df' }}>{r.accent}</span>
						{r.detail ? <span style={styles.detail}>{r.detail}</span> : null}
					</div>
				))}
			</div>
		</div>
	);
};
