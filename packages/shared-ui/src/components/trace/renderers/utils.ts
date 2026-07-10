// =============================================================================
// Shared utilities for trace data renderers
// =============================================================================

import React, { ReactElement, useState } from 'react';
import { RS } from './styles';

// =============================================================================
// COLLAPSIBLE SECTION
// =============================================================================

/** A section with an RS.label header that can be collapsed/expanded. */
export const CollapsibleSection: React.FC<{
	label: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
}> = ({ label, defaultOpen = false, children }) => {
	const [open, setOpen] = useState(defaultOpen);
	return React.createElement(
		'div',
		{ style: RS.section },
		React.createElement(
			'div',
			{
				style: { ...RS.label, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 },
				onClick: () => setOpen(!open),
			},
			React.createElement('span', { style: { fontSize: 8, width: 10 } }, open ? '\u25BC' : '\u25B6'),
			label
		),
		open ? React.createElement('div', { style: RS.sectionContent }, children) : null
	);
};

// =============================================================================
// DEEP EQUALITY
// =============================================================================

/** Deep-equal check for trace data objects (plain JSON, no circular refs). */
export function traceDataEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	return JSON.stringify(a) === JSON.stringify(b);
}

// =============================================================================
// JSON DIFF
// =============================================================================

export type DiffEntry = { op: 'add'; path: string; value: unknown } | { op: 'change'; path: string; from: unknown; to: unknown } | { op: 'delete'; path: string; value: unknown };

const MAX_DIFF_ENTRIES = 10;

/**
 * Compute a shallow structural diff between two objects.
 *
 * - Key only in `after`  → add (don't recurse into the new value)
 * - Key only in `before` → delete (don't recurse into the old value)
 * - Both objects at key  → recurse to find sub-changes
 * - Values differ        → change (don't recurse further)
 * - Values equal         → skip
 *
 * Capped at MAX_DIFF_ENTRIES. Returns the total count for "N more" display.
 */
export function diffObjects(before: unknown, after: unknown): { entries: DiffEntry[]; total: number } {
	const entries: DiffEntry[] = [];
	let total = 0;

	function walk(b: unknown, a: unknown, path: string): void {
		// Both null/undefined or strictly equal
		if (b === a) return;
		if (b == null && a == null) return;

		// One is null
		if (b == null) {
			total++;
			if (entries.length < MAX_DIFF_ENTRIES) entries.push({ op: 'add', path: path || '(root)', value: a });
			return;
		}
		if (a == null) {
			total++;
			if (entries.length < MAX_DIFF_ENTRIES) entries.push({ op: 'delete', path: path || '(root)', value: b });
			return;
		}

		const bIsObj = typeof b === 'object' && !Array.isArray(b);
		const aIsObj = typeof a === 'object' && !Array.isArray(a);

		// Both are plain objects → recurse into keys
		if (bIsObj && aIsObj) {
			const bRec = b as Record<string, unknown>;
			const aRec = a as Record<string, unknown>;
			const allKeys = new Set([...Object.keys(bRec), ...Object.keys(aRec)]);

			for (const key of allKeys) {
				if (entries.length >= MAX_DIFF_ENTRIES && total >= MAX_DIFF_ENTRIES) return;
				const childPath = path ? `${path}.${key}` : key;
				const inB = key in bRec;
				const inA = key in aRec;

				if (!inB && inA) {
					total++;
					if (entries.length < MAX_DIFF_ENTRIES) entries.push({ op: 'add', path: childPath, value: aRec[key] });
				} else if (inB && !inA) {
					total++;
					if (entries.length < MAX_DIFF_ENTRIES) entries.push({ op: 'delete', path: childPath, value: bRec[key] });
				} else {
					// Both have the key — recurse or compare
					const bVal = bRec[key];
					const aVal = aRec[key];
					const bValIsObj = bVal != null && typeof bVal === 'object' && !Array.isArray(bVal);
					const aValIsObj = aVal != null && typeof aVal === 'object' && !Array.isArray(aVal);

					if (bValIsObj && aValIsObj) {
						walk(bVal, aVal, childPath);
					} else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
						total++;
						if (entries.length < MAX_DIFF_ENTRIES) entries.push({ op: 'change', path: childPath, from: bVal, to: aVal });
					}
				}
			}
			return;
		}

		// Different types or non-object → top-level change
		if (JSON.stringify(b) !== JSON.stringify(a)) {
			total++;
			if (entries.length < MAX_DIFF_ENTRIES) entries.push({ op: 'change', path: path || '(root)', from: b, to: a });
		}
	}

	walk(before, after, '');
	return { entries, total };
}

// =============================================================================
// DIFF SUMMARY
// =============================================================================

/** Short summary string for collapsed row display. */
export function summaryDiff(entries: DiffEntry[], total: number): string {
	if (total === 0) return 'no changes';
	if (total === 1) {
		const e = entries[0];
		if (e.op === 'add') return `added ${e.path}`;
		if (e.op === 'delete') return `removed ${e.path}`;
		return `changed ${e.path}`;
	}
	return `${total} changes`;
}

// =============================================================================
// DIFF VIEW COMPONENT
// =============================================================================

function truncateValue(value: unknown, maxLen: number = 80): string {
	if (value == null) return 'null';
	const s = typeof value === 'string' ? value : JSON.stringify(value);
	return s.length > maxLen ? s.slice(0, maxLen) + '\u2026' : s;
}

const diffStyles = {
	row: {
		display: 'flex',
		gap: 6,
		fontSize: 11,
		lineHeight: '18px',
		fontFamily: 'monospace',
	} as React.CSSProperties,
	opAdd: {
		color: 'var(--rr-color-success)',
		fontWeight: 600,
		flexShrink: 0,
		width: 60,
	} as React.CSSProperties,
	opChange: {
		color: 'var(--rr-color-warning)',
		fontWeight: 600,
		flexShrink: 0,
		width: 60,
	} as React.CSSProperties,
	opDelete: {
		color: 'var(--rr-color-error)',
		fontWeight: 600,
		flexShrink: 0,
		width: 60,
	} as React.CSSProperties,
	path: {
		color: 'var(--rr-text-primary)',
		fontWeight: 500,
	} as React.CSSProperties,
	value: {
		color: 'var(--rr-text-secondary)',
		wordBreak: 'break-word' as const,
		minWidth: 0,
	} as React.CSSProperties,
	more: {
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
		fontStyle: 'italic' as const,
		marginTop: 4,
	} as React.CSSProperties,
};

const OP_STYLES: Record<string, React.CSSProperties> = {
	add: diffStyles.opAdd,
	change: diffStyles.opChange,
	delete: diffStyles.opDelete,
};

const OP_LABELS: Record<string, string> = {
	add: '[Add]',
	change: '[Change]',
	delete: '[Delete]',
};

export function DiffView({ before, after }: { before: unknown; after: unknown }): ReactElement {
	const { entries, total } = diffObjects(before, after);

	if (entries.length === 0) {
		return React.createElement('div', { style: RS.muted }, 'No changes');
	}

	const items = entries.map((e, i) => {
		let detail: string;
		if (e.op === 'add') {
			detail = `= ${truncateValue(e.value)}`;
		} else if (e.op === 'delete') {
			detail = `(was ${truncateValue(e.value)})`;
		} else {
			detail = `from ${truncateValue(e.from, 40)} to ${truncateValue(e.to, 40)}`;
		}

		return React.createElement('div', { key: i, style: diffStyles.row }, React.createElement('span', { style: OP_STYLES[e.op] }, OP_LABELS[e.op]), React.createElement('span', { style: diffStyles.path }, e.path), React.createElement('span', { style: diffStyles.value }, detail));
	});

	const remaining = total - entries.length;
	if (remaining > 0) {
		items.push(React.createElement('div', { key: 'more', style: diffStyles.more }, `\u2026 and ${remaining} more changes`));
	}

	return React.createElement('div', null, ...items);
}
