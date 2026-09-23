// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * FilterStrip — the DataGrid's built-in filter row.
 *
 * Rendered by DataGrid above the table when the `filters` prop is set: one
 * labelled control per {@link IGridFilterDef}, in the platform filter-bar
 * style (uppercase labels, 30px controls). Values are controlled by DataGrid,
 * which debounces changes into a remote refetch or, in local mode, its own
 * grid-internal row predicate (plus the optional `onFiltersChange`
 * observation hook) — there is no Apply button.
 *
 * Control types: free text, select (options include their own "All ..."
 * empty-value entry), date, and typeahead (async suggestions; the stored
 * value is the picked item's id while the input shows its name).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// TYPES
// =============================================================================

/** One option of a select or typeahead filter control. */
export interface IGridFilterOption {
	/** Value stored (and sent to fetchPage) when chosen. */
	value: string;
	/** Visible label. */
	label: string;
}

/** Declarative definition of one filter control in the strip. */
export interface IGridFilterDef {
	/** Key under which the value appears in the filters record. */
	key: string;
	/** Uppercase label above the control. */
	label: string;
	/** Control type. */
	type: 'text' | 'select' | 'date' | 'typeahead';
	/** Placeholder for text / typeahead inputs. */
	placeholder?: string;
	/** Options for a select (include an empty-value "All ..." entry). */
	options?: IGridFilterOption[];
	/** Async suggestion lookup for a typeahead (value = picked option's value). */
	search?: (query: string) => Promise<IGridFilterOption[]>;
	/** Control width in px. Defaults per type (text/typeahead 180, others auto). */
	width?: number;
}

/** Props for the {@link FilterStrip} component. */
export interface IFilterStripProps {
	/** The filter controls to render, in order. */
	defs: IGridFilterDef[];
	/**
	 * Current committed values keyed by def key. The record is shared with
	 * the header-popup filters, so values may be arrays ('values' checklists)
	 * — the strip's controls are string-valued and render arrays as ''.
	 */
	values: Record<string, string | string[]>;
	/** Display labels for typeahead selections keyed by def key. */
	labels: Record<string, string>;
	/**
	 * Fired on every user edit.
	 *
	 * @param key - The filter's key.
	 * @param value - The new value ('' clears the filter).
	 * @param label - Display label (typeahead picks only).
	 */
	onChange: (key: string, value: string, label?: string) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// The strip itself: wrapping row of labelled controls above the header.
	strip: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '12px 16px',
		padding: '12px 16px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	// One label + control stack.
	field: {
		display: 'flex',
		flexDirection: 'column',
		gap: 5,
	} as CSSProperties,

	// Uppercase field label (matches the platform filter-bar look).
	label: {
		fontSize: 10.5,
		fontWeight: 600,
		letterSpacing: '0.6px',
		textTransform: 'uppercase',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Native select / date controls, aligned to the 30px input height.
	select: {
		...commonStyles.inputField,
		height: 30,
		cursor: 'pointer',
	} as CSSProperties,

	date: {
		...commonStyles.inputField,
		height: 30,
	} as CSSProperties,

	// Typeahead wrapper anchors the suggestion popup.
	typeaheadWrap: {
		position: 'relative',
	} as CSSProperties,

	// Suggestion popup (popupMenu look).
	dropdown: {
		position: 'absolute',
		top: '100%',
		left: 0,
		right: 0,
		marginTop: 4,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		boxShadow: '0 8px 24px var(--rr-shadow-widget)',
		zIndex: 100,
		maxHeight: 240,
		overflowY: 'auto',
		padding: 4,
	} as CSSProperties,

	// One suggestion row.
	item: (hovered: boolean): CSSProperties => ({
		padding: '6px 10px',
		borderRadius: 6,
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
		background: hovered ? 'var(--rr-bg-list-hover)' : 'transparent',
	}),
};

// =============================================================================
// TYPEAHEAD CONTROL
// =============================================================================

/**
 * Async-suggestion input: debounces the lookup, shows a popup of options,
 * stores the picked option's value while displaying its label. Clearing the
 * input clears the filter immediately.
 *
 * @param props - Definition, committed label, and the change callback.
 * @returns The typeahead control.
 */
const TypeaheadControl: React.FC<{
	def: IGridFilterDef;
	label: string;
	onChange: (value: string, label: string) => void;
}> = ({ def, label, onChange }) => {
	const [text, setText] = useState(label);
	const [results, setResults] = useState<IGridFilterOption[]>([]);
	const [open, setOpen] = useState(false);
	const [hoveredIdx, setHoveredIdx] = useState(-1);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	// External label changes (e.g. a reset) resync the input text.
	useEffect(() => { setText(label); }, [label]);

	/** Debounced suggestion lookup; empty input clears the filter at once. */
	const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const value = e.target.value;
		setText(value);
		if (!value.trim()) {
			onChange('', '');
			setResults([]);
			setOpen(false);
			return;
		}
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(async () => {
			const items = await def.search?.(value.trim()) ?? [];
			setResults(items);
			setOpen(items.length > 0);
			setHoveredIdx(-1);
		}, 250);
	}, [def, onChange]);

	/** Commit a picked suggestion. */
	const handlePick = useCallback((item: IGridFilterOption) => {
		setText(item.label);
		onChange(item.value, item.label);
		setOpen(false);
	}, [onChange]);

	// Outside click dismisses the popup.
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, []);

	return (
		<div ref={wrapRef} style={styles.typeaheadWrap}>
			<input
				style={{ ...commonStyles.inputField, height: 30, width: def.width ?? 180 }}
				placeholder={def.placeholder}
				value={text}
				onChange={handleInput}
				onFocus={() => { if (results.length > 0 && text) setOpen(true); }}
			/>
			{open && (
				<div style={styles.dropdown}>
					{results.map((item, i) => (
						<div
							key={item.value}
							style={styles.item(hoveredIdx === i)}
							onMouseEnter={() => setHoveredIdx(i)}
							onMouseLeave={() => setHoveredIdx(-1)}
							onClick={() => handlePick(item)}
						>
							{item.label}
						</div>
					))}
				</div>
			)}
		</div>
	);
};

// =============================================================================
// FILTER STRIP
// =============================================================================

/**
 * Coerce a shared filter value to the strip's string domain — array values
 * belong to header-popup 'values' checklists and render as '' here.
 *
 * @param value - Raw value from the shared filter record.
 * @returns The string form ('' for arrays / missing keys).
 */
const asString = (value: string | string[] | undefined): string =>
	typeof value === 'string' ? value : '';

/**
 * Render the labelled filter controls row. See the module doc for behavior.
 *
 * @param props - {@link IFilterStripProps}.
 * @returns The strip element.
 */
export const FilterStrip: React.FC<IFilterStripProps> = ({ defs, values, labels, onChange }) => (
	<div style={styles.strip}>
		{defs.map((def) => (
			<div key={def.key} style={styles.field}>
				<span style={styles.label}>{def.label}</span>

				{/* Free-text filter. */}
				{def.type === 'text' && (
					<input
						style={{ ...commonStyles.inputField, height: 30, width: def.width ?? 180 }}
						placeholder={def.placeholder}
						value={asString(values[def.key])}
						onChange={(e) => onChange(def.key, e.target.value)}
					/>
				)}

				{/* Select filter — options carry their own "All ..." entry. */}
				{def.type === 'select' && (
					<select
						style={{ ...styles.select, ...(def.width ? { width: def.width } : {}) }}
						value={asString(values[def.key])}
						onChange={(e) => onChange(def.key, e.target.value)}
					>
						{(def.options ?? []).map((opt) => (
							<option key={opt.value} value={opt.value}>{opt.label}</option>
						))}
					</select>
				)}

				{/* Date filter (native picker). */}
				{def.type === 'date' && (
					<input
						type="date"
						style={{ ...styles.date, ...(def.width ? { width: def.width } : {}) }}
						value={asString(values[def.key])}
						onChange={(e) => onChange(def.key, e.target.value)}
					/>
				)}

				{/* Async typeahead filter. */}
				{def.type === 'typeahead' && (
					<TypeaheadControl
						def={def}
						label={labels[def.key] ?? ''}
						onChange={(value, label) => onChange(def.key, value, label)}
					/>
				)}
			</div>
		))}
	</div>
);
