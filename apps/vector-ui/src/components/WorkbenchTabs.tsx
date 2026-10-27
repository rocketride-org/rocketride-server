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
// nothing a run or a refresh changes in the header moves them.
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { ToggleGroup } from 'shell';
import { WORKBENCH_TABS, tabLabel } from '../vector/workbench';
import type { WorkbenchTab } from '../vector/workbench';

const styles = {
	row: { flexShrink: 0, display: 'flex', alignItems: 'center', padding: '8px 24px 0' } as CSSProperties,
};

/** Props for the {@link WorkbenchTabs} component. */
export interface IWorkbenchTabsProps {
	value: WorkbenchTab;
	onChange(tab: WorkbenchTab): void;
	/** Documents in the trash as the store counts them, or null where it cannot count. */
	trashCount: number | null;
}

/**
 * The tab row.
 *
 * @param props - {@link IWorkbenchTabsProps}.
 * @returns The row.
 */
export function WorkbenchTabs({ value, onChange, trashCount }: IWorkbenchTabsProps): React.ReactElement {
	const options = useMemo(() => WORKBENCH_TABS.map((tab) => ({ id: tab.id, label: tabLabel(tab.id, { trash: trashCount }) })), [trashCount]);
	return (
		<div style={styles.row} data-workbench-tabs="">
			<ToggleGroup options={options} value={value} onChange={onChange} />
		</div>
	);
}

export default WorkbenchTabs;
