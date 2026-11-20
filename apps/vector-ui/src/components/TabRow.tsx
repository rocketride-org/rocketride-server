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
// VECTOR-UI - A ROW OF TABS (the workbench's and the Overview's)
// =============================================================================
//
// An APG tab list with a roving tabindex: Left and Right move along it
// (wrapping), Home and End jump. With MANUAL activation the keys only move
// the focus and Enter or Space (a click) shows the tab: the workbench's row,
// where a tab may call the store (the Map draws a sample). With AUTOMATIC
// activation the keys show the tab they reach: views that call nothing.
// Each tab names its panel (`aria-controls`) and each panel its tab
// (`tabRowIds`). A label whose count changes keeps its width: its digits are
// tabular, and a `reserve` label (the widest it usually gets) shares its
// grid cell, invisibly.
// =============================================================================

import React, { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { FOCUS_RING } from '../styles';
import { tabKeyTarget } from '../vector/workbench';

const styles = {
	row: (small: boolean): CSSProperties => ({ flexShrink: 0, display: 'flex', alignItems: 'flex-end', gap: 4, padding: '6px 24px 0', borderBottom: small ? 'none' : '1px solid var(--rr-border)' }),
	tab: (selected: boolean, focused: boolean, small: boolean): CSSProperties => ({
		padding: small ? '4px 8px' : '6px 10px 5px',
		border: 'none',
		borderBottom: selected ? '2px solid var(--rr-border-focus)' : '2px solid transparent',
		background: 'none',
		color: 'var(--rr-text-primary)',
		font: 'inherit',
		fontSize: small ? 12 : 13,
		fontWeight: selected ? 600 : 400,
		fontVariantNumeric: 'tabular-nums',
		whiteSpace: 'nowrap',
		cursor: 'pointer',
		outline: focused ? FOCUS_RING : 'none',
		outlineOffset: -2,
	}),
	/** The label and its reserve in one grid cell: the tab is as wide as the wider of the two. */
	cell: { display: 'inline-grid' } as CSSProperties,
	reserve: { gridArea: '1 / 1', visibility: 'hidden', fontWeight: 600 } as CSSProperties,
	label: { gridArea: '1 / 1' } as CSSProperties,
};

/** One tab of a row. */
export interface ITabRowTab<T extends string> {
	id: T;
	label: string;
	/** The widest label this tab usually shows (a count of three digits), so a changing count keeps its width. */
	reserve?: string;
}

/**
 * The ids of a row's tab and its panel, so each names the other.
 *
 * @param prefix - The row's unique prefix.
 * @param tab - The tab.
 * @returns The tab's id and its panel's id.
 */
export function tabRowIds(prefix: string, tab: string): { tab: string; panel: string } {
	return { tab: `${prefix}-tab-${tab}`, panel: `${prefix}-panel-${tab}` };
}

/** Props for the {@link TabRow} component. */
export interface ITabRowProps<T extends string> {
	tabs: ReadonlyArray<ITabRowTab<T>>;
	value: T;
	onSelect(tab: T): void;
	/** 'manual': the keys move the focus only; 'automatic': they show the tab they reach. */
	activation: 'manual' | 'automatic';
	/** The tab list's accessible name. */
	label: string;
	/** The row's unique prefix for the tab and panel ids ({@link tabRowIds}). */
	idPrefix: string;
	/** The smaller row (views inside a tab). */
	small?: boolean;
	/** A data attribute on the row, so the workbench finds its tabs. */
	marker?: string;
	/** The tabs whose panels are on the page (they mount the first time they show): only those name their panel. */
	mounted?: ReadonlySet<T>;
}

/**
 * A row of tabs.
 *
 * @param props - {@link ITabRowProps}.
 * @returns The row.
 */
export function TabRow<T extends string>({ tabs, value, onSelect, activation, label, idPrefix, small = false, marker, mounted }: ITabRowProps<T>): React.ReactElement {
	const row = useRef<HTMLDivElement>(null);
	const [focused, setFocused] = useState<T | null>(null);
	const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
		const target = tabKeyTarget(event.key, index, tabs.length);
		if (target === null) return;
		event.preventDefault();
		if (activation === 'automatic') onSelect(tabs[target].id);
		row.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
	};
	return (
		<div ref={row} role="tablist" aria-label={label} style={styles.row(small)} {...(marker ? { [`data-${marker}`]: '' } : {})}>
			{tabs.map((tab, index) => {
				const selected = tab.id === value;
				const ids = tabRowIds(idPrefix, tab.id);
				return (
					<button
						key={tab.id}
						type="button"
						role="tab"
						id={ids.tab}
						aria-selected={selected}
						// A panel mounts the first time its tab shows: a tab names its panel once it is on the page.
						aria-controls={mounted === undefined || mounted.has(tab.id) || selected ? ids.panel : undefined}
						tabIndex={selected ? 0 : -1}
						style={styles.tab(selected, focused === tab.id, small)}
						onClick={() => onSelect(tab.id)}
						onKeyDown={(event) => onKeyDown(event, index)}
						onFocus={() => setFocused(tab.id)}
						onBlur={() => setFocused((current) => (current === tab.id ? null : current))}
					>
						{tab.reserve ? (
							<span style={styles.cell}>
								<span style={styles.label}>{tab.label}</span>
								<span aria-hidden="true" style={styles.reserve}>
									{tab.reserve}
								</span>
							</span>
						) : (
							tab.label
						)}
					</button>
				);
			})}
		</div>
	);
}

export default TabRow;
