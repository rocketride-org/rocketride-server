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
// GRAPH-UI - RESULT TABLE AND RAW VIEW
// =============================================================================
//
// The Table lists EVERY returned row, scalars and graph entities alike: it is the
// full, accessible alternative to the canvas. Columns are keyed by position
// (`c0`, `c1`, ...), never by name, so a result that names the same column twice
// keeps both. Raw is the exact envelope as pretty JSON (precision-safe: anything a
// JSON number cannot carry arrived as text).
// =============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Card, CardDataGrid, monoEl, mutedEl } from 'shell';
import type { GridCellComponent, GridColumnDefinition } from 'shell';
import { columnGridTypes, columnKeys, rawView, toGridRows } from '../graph/results';
import type { ReadQueryResult } from '../graph/types';
import { describeValue } from '../graph/values';
import { COPY_BLOCKED_NOTE } from '../graph/wording';
import { useGraphEnv } from '../env';

// =============================================================================
// TABLE
// =============================================================================

/**
 * One cell, as the grid shows it.
 *
 * @param value - A cell value.
 * @returns The element.
 */
function cellEl(value: unknown): HTMLElement {
	if (value === null || value === undefined) return mutedEl('null');
	const text = describeValue(value);
	const el = monoEl(text);
	el.title = text.length > 200 ? 'Open the row to see the whole value' : text;
	return el;
}

/** Props for the table. */
export interface IResultTableProps {
	result: ReadQueryResult;
	/** A key that changes with the result, so the grid resets its layout state. */
	tableKey: string;
	/** Fired with the row's position when a row is clicked. */
	onRowOpen(rowIndex: number): void;
	/** The text above the grid (counts, limit, timing). */
	meta: React.ReactNode;
}

/**
 * The result table.
 *
 * @param props - See {@link IResultTableProps}.
 * @returns The table inside a card.
 */
export const ResultTable: React.FC<IResultTableProps> = ({ result, tableKey, onRowOpen, meta }) => {
	// Grid layouts: the env's (session-only copies in a dev-tool frame).
	const env = useGraphEnv();
	const rows = useMemo(() => toGridRows(result), [result]);
	const columns = useMemo<GridColumnDefinition[]>(() => {
		const keys = columnKeys(result.columns);
		const types = columnGridTypes(result);
		return result.columns.map((name, i) => ({
			title: name === '' ? `(column ${i + 1})` : name,
			// The grid draws headers in capitals; a Cypher column name is case-sensitive (`n` and `N` differ), so show it as it is.
			titleFormatter: () => {
				const span = document.createElement('span');
				span.textContent = name === '' ? `(column ${i + 1})` : name;
				span.style.textTransform = 'none';
				return span;
			},
			field: keys[i],
			rrType: types[i],
			rrDefault: true,
			rrDescription: `Result column ${i + 1}${name ? `: ${name}` : ''}.`,
			headerSort: types[i] === 'number',
			hozAlign: types[i] === 'number' ? 'right' : undefined,
			formatter: (cell: GridCellComponent) => cellEl(cell.getValue()),
		})) as GridColumnDefinition[];
	}, [result]);

	return (
		<Card noBodyPadding fill>
			<CardDataGrid<Record<string, unknown>>
				title="Results"
				actions={<span style={metaStyle}>{meta}</span>}
				columns={columns}
				data={rows}
				tableId={`graph-results-${tableKey}`}
				persistence={env.gridPersistence}
				paginate={false}
				height="100%"
				emptyTitle="No rows"
				emptyDescription="The query returned no rows."
				onRowClick={(row) => onRowOpen(Number(row.__row))}
			/>
		</Card>
	);
};

const metaStyle: CSSProperties = { display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--rr-text-secondary)' };

// =============================================================================
// RAW
// =============================================================================

/**
 * Copy text to the clipboard (with the legacy path for contexts without the async API).
 *
 * @param text - What to copy.
 * @returns True when it was copied.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path
	}
	try {
		const area = document.createElement('textarea');
		area.value = text;
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(area);
		return ok;
	} catch {
		return false;
	}
}

/**
 * What a blocked copy leaves on screen: the note and the text, read-only and selected on focus, so it can be copied by
 * hand (R11: degrade visibly).
 *
 * @param props.text - What could not be copied.
 * @returns The fallback.
 */
export const CopyBlocked: React.FC<{ text: string }> = ({ text }) => (
	<div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '0 0 8px' }}>
		<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)' }}>{COPY_BLOCKED_NOTE}</div>
		<textarea readOnly value={text} aria-label="Text to copy" rows={6} onFocus={(event) => event.currentTarget.select()} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, background: 'var(--rr-bg-paper)', color: 'var(--rr-text-primary)', border: '1px solid var(--rr-border)', borderRadius: 4 }} />
	</div>
);

/** Props for the raw view. */
export interface IRawViewProps {
	result: ReadQueryResult;
	announce(text: string): void;
}

/**
 * The Raw view: the exact envelope as JSON, bounded for display, with a copy button
 * that copies all of it.
 *
 * @param props - See {@link IRawViewProps}.
 * @returns The view.
 */
export const RawView: React.FC<IRawViewProps> = ({ result, announce }) => {
	const view = useMemo(() => rawView(result), [result]);
	const [copied, setCopied] = useState(false);
	const [blocked, setBlocked] = useState<string | null>(null);
	const copy = useCallback(async () => {
		const text = JSON.stringify(result, null, 2);
		const ok = await copyText(text);
		setCopied(ok);
		setBlocked(ok ? null : text);
		announce(ok ? 'Copied the result as JSON.' : 'Copying was not allowed by the browser.');
	}, [result, announce]);
	return (
		<Card header="Raw result" headerActions={<Button variant="ghost" small onClick={() => void copy()}>{copied ? 'Copied' : 'Copy JSON'}</Button>} noBodyPadding fill>
			<div style={{ height: '100%', overflow: 'auto', padding: 12 }}>
				{blocked !== null && <CopyBlocked text={blocked} />}
				{view.cut && (
					<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginBottom: 8 }}>
						Showing the first {RAW_LIMIT_TEXT} characters of {view.length.toLocaleString('en-US')}. Copy JSON copies all of it.
					</div>
				)}
				<pre style={{ margin: 0, fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} tabIndex={0} aria-label="Raw result JSON">
					{view.text}
				</pre>
			</div>
		</Card>
	);
};

const RAW_LIMIT_TEXT = '400,000';
