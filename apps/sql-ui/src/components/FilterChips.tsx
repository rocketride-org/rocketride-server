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
// SQL-UI — FILTER CHIPS (filter and sort chips above the data grid)
// =============================================================================
//
// "+ Filter" adds a `{column, op, value}` chip; the sort chips mirror the
// grid's sorters, and removing one clears that sorter. The chips hold no SQL:
// the view hands them to `buildPageStatements`, which binds every value.
// Chip filters combine with the header filters and the search by AND.
// =============================================================================

import React, { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Chip, InputField } from 'shell';
import { FILTER_OPS, describeChip, isCompleteChip, textMatchHint } from '../sql/filters';
import type { FilterChip, FilterOp } from '../sql/filters';
import type { SqlDialect } from '../connect';

/** One active sorter of the grid. */
export interface SortChip {
	/** The sorted column. */
	field: string;
	/** The direction. */
	dir: 'asc' | 'desc';
}

/** Props for the {@link FilterChips} component. */
export interface FilterChipsProps {
	/** The table's columns, in schema order. */
	columns: readonly string[];
	/** The filter chips. */
	chips: readonly FilterChip[];
	/** Fired with the new chip list when one is added or removed. */
	onChipsChange: (chips: FilterChip[]) => void;
	/** The grid's current sorters. */
	sort: readonly SortChip[];
	/** Fired with the sorters that remain when a sort chip is removed. */
	onSortChange: (sort: SortChip[]) => void;
	/** The engine dialect: which matches ignore case depends on it. */
	dialect: SqlDialect;
}

const styles = {
	root: {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'center',
		gap: 8,
		margin: '0 0 8px',
		fontSize: 12,
	} as CSSProperties,

	label: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	form: {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'flex-end',
		gap: 8,
		width: '100%',
		padding: 8,
		borderRadius: 7,
		border: '1px solid var(--rr-border)',
	} as CSSProperties,

	field: {
		display: 'flex',
		flexDirection: 'column',
		gap: 2,
	} as CSSProperties,

	select: {
		height: 34,
		minWidth: 140,
		padding: '0 8px',
		borderRadius: 7,
		border: '1px solid var(--rr-border-default, var(--rr-bg-widget))',
		background: 'var(--rr-bg-default)',
		color: 'var(--rr-text-primary)',
		font: 'inherit',
		fontSize: 12.5,
	} as CSSProperties,

	hint: {
		width: '100%',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

/**
 * The chip strip: filter chips, sort chips, "+ Filter" and "Clear all".
 *
 * @param props - {@link FilterChipsProps}.
 * @returns The strip element.
 */
export const FilterChips: React.FC<FilterChipsProps> = ({ columns, chips, onChipsChange, sort, onSortChange, dialect }) => {
	const id = useId();
	const [adding, setAdding] = useState(false);
	const [column, setColumn] = useState('');
	const [op, setOp] = useState<FilterOp>('eq');
	const [value, setValue] = useState('');

	const needsValue = FILTER_OPS.find((o) => o.op === op)?.needsValue ?? true;
	const draft: FilterChip = { column: column || columns[0] || '', op, ...(needsValue ? { value } : {}) };

	/** Close the form and forget what was typed. */
	const reset = (): void => {
		setAdding(false);
		setColumn('');
		setOp('eq');
		setValue('');
	};

	/** Add the chip being drafted. */
	const add = (): void => {
		if (!isCompleteChip(draft)) return;
		onChipsChange([...chips, draft]);
		reset();
	};

	const anything = chips.length > 0 || sort.length > 0;

	return (
		<div style={styles.root}>
			{chips.map((chip, index) => (
				<Chip
					key={`${index}:${describeChip(chip)}`}
					label={describeChip(chip)}
					onRemove={() => onChipsChange(chips.filter((_, i) => i !== index))}
				/>
			))}
			{sort.map((s) => (
				<Chip
					key={`sort:${s.field}`}
					label={`${s.field} ${s.dir === 'asc' ? 'ascending' : 'descending'}`}
					onRemove={() => onSortChange(sort.filter((other) => other.field !== s.field))}
				/>
			))}
			{!adding && <Button variant="ghost" small onClick={() => setAdding(true)}>+ Filter</Button>}
			{anything && !adding && (
				<Button
					variant="ghost"
					small
					onClick={() => {
						onChipsChange([]);
						onSortChange([]);
					}}
				>
					Clear all
				</Button>
			)}

			{adding && (
				<div style={styles.form}>
					<span style={styles.field}>
						<label htmlFor={`${id}-col`} style={styles.label}>Column</label>
						<select id={`${id}-col`} style={styles.select} value={draft.column} onChange={(e) => setColumn(e.target.value)}>
							{columns.map((name) => <option key={name} value={name}>{name}</option>)}
						</select>
					</span>
					<span style={styles.field}>
						<label htmlFor={`${id}-op`} style={styles.label}>Operator</label>
						<select id={`${id}-op`} style={styles.select} value={op} onChange={(e) => setOp(e.target.value as FilterOp)}>
							{FILTER_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
						</select>
					</span>
					{needsValue && (
						<span style={styles.field}>
							<label htmlFor={`${id}-val`} style={styles.label}>Value</label>
							<InputField
								id={`${id}-val`}
								value={value}
								autoFocus
								onChange={(e) => setValue(e.target.value)}
								onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
							/>
						</span>
					)}
					<Button variant="primary" small disabled={!isCompleteChip(draft)} onClick={add}>Add filter</Button>
					<Button variant="ghost" small onClick={reset}>Cancel</Button>
					<div style={styles.hint}>
						{textMatchHint(dialect)}
					</div>
				</div>
			)}
		</div>
	);
};

export default FilterChips;
