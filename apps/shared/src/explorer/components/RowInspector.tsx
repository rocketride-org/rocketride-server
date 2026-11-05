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
// EXPLORER — ROW INSPECTOR (one result row, in full, in a drawer)
// =============================================================================
//
// A grid cell truncates; this shows one row's values whole, with a copy
// affordance per value. Fields are POSITIONAL, so a result that names the same
// column twice shows both. The text for "Copy row as JSON" and the note under
// the values are the app's: only it knows what its values lose in transit
// (SQL: decimals arrive as floating point; Graph: ids and large integers are
// kept as strings, so its JSON is built to be precision-safe).
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, DetailPanel, LabelValue, Section } from 'shell';

/** One value of the row. */
export interface IInspectorField {
	/** The column name (may repeat). */
	label: string;
	/** The value. */
	value: unknown;
	/** Text to copy for this value (default: the rendered text). */
	copyText?: string;
}

/** Props for the {@link RowInspector} component. */
export interface IRowInspectorProps {
	/** Whether the drawer is open. */
	open: boolean;
	/** Drawer title, e.g. `Row 3 of 120`. */
	title: string;
	/** Drawer subtitle, e.g. `statement 2 · executed 14:02`. */
	subtitle: string;
	/** The row's values, in column order. */
	fields: readonly IInspectorField[];
	/** The text "Copy row as JSON" puts on the clipboard (the caller makes it precision-safe). */
	json: string;
	/** The note under the values. */
	note: string;
	/** How a null reads (default `NULL`). */
	nullText?: string;
	/** Politely announce a sentence (the app's announcer). */
	announce: (text: string) => void;
	/** Fired when the drawer is dismissed. */
	onClose: () => void;
}

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

/**
 * Render one value as text: null spelled out, objects pretty-printed.
 *
 * @param value - The raw value.
 * @param nullText - How a null reads.
 * @returns The text to show and to copy.
 */
export function inspectorText(value: unknown, nullText = 'NULL'): string {
	if (value === null || value === undefined) return nullText;
	if (typeof value === 'object') return JSON.stringify(value, null, '\t');
	return String(value);
}

/**
 * Copy text to the clipboard and announce it.
 *
 * The Clipboard API rejects without a user gesture, and is absent entirely
 * outside a secure context; either way the failure announces itself rather
 * than passing silently, because the user has no other signal that nothing was
 * copied.
 *
 * @param text - The text to copy.
 * @param what - What was copied, for the announcement.
 * @param announce - The app's announcer.
 */
function copy(text: string, what: string, announce: (text: string) => void): void {
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

/**
 * The row inspector drawer.
 *
 * @param props - {@link IRowInspectorProps}.
 * @returns The drawer element.
 */
export const RowInspector: React.FC<IRowInspectorProps> = ({ open, title, subtitle, fields, json, note, nullText, announce, onClose }) => {
	return (
		<DetailPanel
			open={open}
			onClose={onClose}
			title={title}
			subtitle={subtitle}
			modeless
			width={460}
			footer={
				<>
					<Button variant="secondary" onClick={() => copy(json, 'row as JSON', announce)}>
						Copy row as JSON
					</Button>
					<Button variant="ghost" onClick={onClose}>Close</Button>
				</>
			}
		>
			{fields.map((field, index) => {
				const text = inspectorText(field.value, nullText);
				return (
					<Section key={`${index}:${field.label}`} label={field.label}>
						<LabelValue label="Value" mono>
							<div style={styles.valueRow}>
								<pre style={styles.value}>{text}</pre>
								<Button variant="ghost" small title={`Copy ${field.label}`} onClick={() => copy(field.copyText ?? text, field.label, announce)}>
									Copy
								</Button>
							</div>
						</LabelValue>
					</Section>
				);
			})}
			<div style={styles.note}>{note}</div>
		</DetailPanel>
	);
};

export default RowInspector;
