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
// VECTOR-UI - THE WORKBENCH'S TAB ROW
// =============================================================================
//
// Overview, Documents, Query, Map, Collection and Trash (with the store's
// count of trashed documents), on a row of their own under the header, so
// nothing a run or a refresh changes in the header moves them. An APG tab
// list with a roving tabindex: Left and Right move along it (wrapping), Home
// and End jump; Enter or Space (a click) shows the tab. Activation is manual,
// so arrowing along the row never opens a tab that calls the store (the Map
// draws a sample). Digits are tabular, so a count that changes keeps the
// label's width.
// =============================================================================

import React, { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { FOCUS_RING } from '../styles';
import { WORKBENCH_TABS, tabKeyTarget, tabLabel } from '../vector/workbench';
import type { WorkbenchTab } from '../vector/workbench';

const styles = {
	row: { flexShrink: 0, display: 'flex', alignItems: 'flex-end', gap: 4, padding: '6px 24px 0', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	tab: (selected: boolean, focused: boolean): CSSProperties => ({
		padding: '6px 10px 5px',
		border: 'none',
		borderBottom: selected ? '2px solid var(--rr-border-focus)' : '2px solid transparent',
		background: 'none',
		color: 'var(--rr-text-primary)',
		font: 'inherit',
		fontSize: 13,
		fontWeight: selected ? 600 : 400,
		fontVariantNumeric: 'tabular-nums',
		whiteSpace: 'nowrap',
		cursor: 'pointer',
		outline: focused ? FOCUS_RING : 'none',
		outlineOffset: -2,
	}),
};

/**
 * The ids of a workbench's tab and panel, so each names the other.
 *
 * @param prefix - The workbench's unique prefix.
 * @param tab - The tab.
 * @returns The tab's id and its panel's id.
 */
export function workbenchIds(prefix: string, tab: WorkbenchTab): { tab: string; panel: string } {
	return { tab: `${prefix}-tab-${tab}`, panel: `${prefix}-panel-${tab}` };
}

/** Props for the {@link WorkbenchTabs} component. */
export interface IWorkbenchTabsProps {
	value: WorkbenchTab;
	onChange(tab: WorkbenchTab): void;
	/** Documents in the trash as the store counts them, or null where it cannot count. */
	trashCount: number | null;
	/** The workbench's unique prefix for the tab and panel ids ({@link workbenchIds}). */
	idPrefix: string;
}

/**
 * The tab row.
 *
 * @param props - {@link IWorkbenchTabsProps}.
 * @returns The row.
 */
export function WorkbenchTabs({ value, onChange, trashCount, idPrefix }: IWorkbenchTabsProps): React.ReactElement {
	const row = useRef<HTMLDivElement>(null);
	const [focused, setFocused] = useState<WorkbenchTab | null>(null);
	const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
		const target = tabKeyTarget(event.key, index, WORKBENCH_TABS.length);
		if (target === null) return;
		event.preventDefault();
		row.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
	};
	return (
		<div ref={row} role="tablist" aria-label="Connection" style={styles.row} data-workbench-tabs="">
			{WORKBENCH_TABS.map((tab, index) => {
				const selected = tab.id === value;
				const ids = workbenchIds(idPrefix, tab.id);
				return (
					<button
						key={tab.id}
						type="button"
						role="tab"
						id={ids.tab}
						aria-selected={selected}
						aria-controls={ids.panel}
						tabIndex={selected ? 0 : -1}
						style={styles.tab(selected, focused === tab.id)}
						onClick={() => onChange(tab.id)}
						onKeyDown={(event) => onKeyDown(event, index)}
						onFocus={() => setFocused(tab.id)}
						onBlur={() => setFocused((current) => (current === tab.id ? null : current))}
					>
						{tabLabel(tab.id, { trash: trashCount })}
					</button>
				);
			})}
		</div>
	);
}

export default WorkbenchTabs;
