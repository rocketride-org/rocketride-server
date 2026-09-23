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
// SQL-UI — CELL INSPECTOR (one result row, in full, in a drawer)
// =============================================================================
//
// A grid cell truncates; this shows one row's values whole, with a copy
// affordance per value. It also states the one thing a result grid cannot
// show: the node converts `Decimal` to a float before the value ever reaches
// the browser (db_instance_base._sanitize_value), and integers beyond 2^53
// cannot survive JSON either — so a displayed number is not always the number
// the database holds.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, DetailPanel, LabelValue, Section } from 'shell';
import { announce } from '../a11y/announce';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link CellInspector} component. */
export interface ICellInspectorProps {
	/** Whether the drawer is open. */
	open: boolean;
	/** The row to inspect (null renders nothing). */
	row: Record<string, unknown> | null;
	/** One-based position of this row in the displayed result. */
	rowNumber: number;
	/** Total rows in the displayed result. */
	rowCount: number;
	/** Drawer subtitle, e.g. `statement 2 · executed 14:02`. */
	subtitle: string;
	/** Fired when the drawer is dismissed. */
	onClose: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Value + copy button on one line; the value wraps, the button does not.
	valueRow: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 8,
	} as CSSProperties,

	value: {
		flex: 1,
		minWidth: 0,
		margin: 0,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,

	note: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		padding: '8px 0 0',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Render one value as text: NULL spelled out, objects pretty-printed.
 *
 * @param value - The raw value.
 * @returns The text to show and to copy.
 */
function asText(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'object') return JSON.stringify(value, null, '\t');
	return String(value);
}

/**
 * Copy text to the clipboard and announce it.
 *
 * The Clipboard API rejects without a user gesture, and is absent entirely
 * outside a secure context; either way the failure announces itself rather
 * than passing silently, because the user has no other signal that nothing
 * was copied.
 *
 * @param text - The text to copy.
 * @param what - What was copied, for the announcement.
 */
function copy(text: string, what: string): void {
	// An absent Clipboard API (an insecure context, an old browser) took the
	// optional chain and skipped BOTH callbacks, so the button did nothing and
	// said nothing. A missing API is a failure to copy like any other.
	if (!navigator.clipboard) {
		announce(`Could not copy ${what}`);
		return;
	}
	void navigator.clipboard.writeText(text).then(
		() => { announce(`Copied ${what}`); },
		() => { announce(`Could not copy ${what}`); },
	);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The row inspector drawer.
 *
 * @param props - {@link ICellInspectorProps}.
 * @returns The drawer element, or null when there is no row.
 */
export const CellInspector: React.FC<ICellInspectorProps> = ({ open, row, rowNumber, rowCount, subtitle, onClose }) => {
	if (!row) return null;
	const columns = Object.keys(row);
	return (
		<DetailPanel
			open={open}
			onClose={onClose}
			title={`Row ${rowNumber} of ${rowCount.toLocaleString()}`}
			subtitle={subtitle}
			modeless
			width={460}
			footer={
				<>
					<Button variant="secondary" onClick={() => copy(JSON.stringify(row, null, '\t'), 'row as JSON')}>
						Copy row as JSON
					</Button>
					<Button variant="ghost" onClick={onClose}>Close</Button>
				</>
			}
		>
			{columns.map((column) => (
				<Section key={column} label={column}>
					<LabelValue label="Value" mono>
						<div style={styles.valueRow}>
							<pre style={styles.value}>{asText(row[column])}</pre>
							<Button variant="ghost" small title={`Copy ${column}`} onClick={() => copy(asText(row[column]), column)}>
								Copy
							</Button>
						</div>
					</LabelValue>
				</Section>
			))}
			<div style={styles.note}>
				Values as received: decimals arrive as floating point; integers above 2^53 may be rounded.
			</div>
		</DetailPanel>
	);
};

export default CellInspector;
