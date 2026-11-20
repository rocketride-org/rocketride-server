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
// REQUIREMENTS CHECKLIST — the read-only check rows both PACKAGE pages share
// =============================================================================

/**
 * The checklist rows of PACKAGE › Requirements (named-pipes mockups 1.8 and
 * 2.10): one mark per item (pass, warn, fail, or the hollow "not yet" of a
 * ladder step still ahead), the item's label and an optional note. ONE
 * component for both kinds — the app page feeds it the manifest preflight,
 * the pipeline page the checks it derives from the document and the rail.
 * The rows are read-only by design: the fix for every item lives on the
 * side tab that owns the field.
 */

import React, { CSSProperties } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** The outcome of one checklist item. */
export type RequirementState = 'pass' | 'warn' | 'fail' | 'pending';

/** One row of the checklist. An app {@link PreflightCheck} is assignable. */
export interface IRequirementItem {
	/** Stable id (the React key). */
	id: string;
	/** The mark: pass, warn, fail, or pending (a ladder step not reached yet). */
	state: RequirementState;
	/** Row label. */
	label: string;
	/** Supporting note ("2 include paths resolve"), trimmed to one line. */
	note?: string;
}

/** Props for {@link RequirementsChecklist}. */
export interface IRequirementsChecklistProps {
	/** The rows, in page order. */
	items: IRequirementItem[];
	/** One sentence above the rows, telling what the marks add up to. */
	lead?: string;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	lead: {
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.6,
		marginBottom: 8,
	} as CSSProperties,
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '6px 0',
		fontSize: 12.5,
		borderTop: '1px solid var(--rr-bg-widget-header)',
	} as CSSProperties,
	rowFirst: {
		borderTop: 'none',
	} as CSSProperties,
	mark: {
		width: 16,
		height: 16,
		borderRadius: '50%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 10,
		fontWeight: 800,
		flexShrink: 0,
	} as CSSProperties,
	text: {
		flex: 1,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	note: {
		color: 'var(--rr-text-disabled)',
		fontSize: 11.5,
		maxWidth: '55%',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,
};

/** Mark palette per state (the Store card's exact grammar; pending is the hollow ring of mockup 2.10). */
const MARK: Record<RequirementState, { bg: string; fg: string; glyph: string; ring?: string }> = {
	pass: { bg: 'rgba(34,153,84,0.14)', fg: 'var(--rr-color-success)', glyph: '✓' },
	warn: { bg: 'rgba(232,185,49,0.18)', fg: 'var(--rr-color-warning)', glyph: '!' },
	fail: { bg: 'rgba(244,67,54,0.14)', fg: 'var(--rr-color-error)', glyph: '✕' },
	pending: { bg: 'transparent', fg: 'var(--rr-text-disabled)', glyph: '', ring: '1px solid var(--rr-border)' },
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the checklist rows.
 *
 * @param props - See {@link IRequirementsChecklistProps}.
 * @returns The lead line and the rows.
 */
export const RequirementsChecklist: React.FC<IRequirementsChecklistProps> = ({ items, lead }) => (
	<>
		{lead ? <div style={styles.lead}>{lead}</div> : null}
		{items.map((item, index) => {
			const mark = MARK[item.state];
			return (
				<div key={item.id} style={index === 0 ? { ...styles.row, ...styles.rowFirst } : styles.row}>
					<div style={{ ...styles.mark, background: mark.bg, color: mark.fg, ...(mark.ring ? { border: mark.ring } : {}) }} aria-label={item.state}>
						{mark.glyph}
					</div>
					<div style={styles.text}>{item.label}</div>
					{item.note ? (
						<div style={styles.note} title={item.note}>
							{item.note}
						</div>
					) : null}
				</div>
			);
		})}
	</>
);

RequirementsChecklist.displayName = 'RequirementsChecklist';
