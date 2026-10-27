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
// SQL-UI — SHORTCUT SHEET (the keys the app answers to)
// =============================================================================
//
// Lists only keys that exist today. The editor's keys are bound in
// SqlEditor.tsx; `?` is bound by the workbench (see shortcuts.ts).
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, Modal } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ShortcutSheet} component. */
export interface ShortcutSheetProps {
	/** Fired when the sheet is dismissed. */
	onClose: () => void;
}

/** One group of keys on the sheet. */
interface ShortcutGroup {
	/** Group heading. */
	heading: string;
	/** What each key does. */
	rows: Array<{ action: string; keys: string }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const GROUPS: ShortcutGroup[] = [
	{
		heading: 'In the query editor',
		rows: [
			{ action: 'Run the selection, or the statement at the cursor', keys: 'Ctrl or Cmd + Enter' },
			{ action: 'Run every statement, stopping at the first error', keys: 'Ctrl or Cmd + Shift + Enter' },
			{ action: 'Explain the statement Run would send', keys: 'Ctrl or Cmd + Shift + E' },
			{ action: 'On a schema-only node a run from the keyboard sends nothing and says why; Check again on the query page looks again', keys: 'Ctrl or Cmd + Enter' },
		],
	},
	{
		heading: 'Anywhere else',
		rows: [
			{ action: 'Show this list', keys: '?' },
			{ action: 'Close a drawer or this list', keys: 'Esc' },
		],
	},
];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	heading: {
		margin: '12px 0 4px',
		fontSize: 12,
		fontWeight: 600,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	row: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 16,
		padding: '6px 0',
		fontSize: 13,
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	keys: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * A dialog that lists the keyboard shortcuts.
 *
 * @param props - {@link ShortcutSheetProps}.
 * @returns The dialog element.
 */
export const ShortcutSheet: React.FC<ShortcutSheetProps> = ({ onClose }) => (
	<Modal title="Keyboard shortcuts" onClose={onClose} width={520} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
		{GROUPS.map((group) => (
			<section key={group.heading} aria-label={group.heading}>
				<h3 style={styles.heading}>{group.heading}</h3>
				{group.rows.map((row) => (
					<div key={row.action} style={styles.row}>
						<span>{row.action}</span>
						<span style={styles.keys}>{row.keys}</span>
					</div>
				))}
			</section>
		))}
	</Modal>
);

export default ShortcutSheet;
