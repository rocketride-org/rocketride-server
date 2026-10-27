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
// nothing a run or a refresh changes in the header moves them. A TabRow
// with MANUAL activation: arrowing along the row never opens a tab that
// calls the store (the Map draws a sample). The Trash label reserves the
// width of a three-digit count.
// =============================================================================

import React from 'react';
import { WORKBENCH_TABS, tabLabel } from '../vector/workbench';
import type { WorkbenchTab } from '../vector/workbench';
import TabRow, { tabRowIds } from './TabRow';

/**
 * The ids of a workbench's tab and panel, so each names the other.
 *
 * @param prefix - The workbench's unique prefix.
 * @param tab - The tab.
 * @returns The tab's id and its panel's id.
 */
export function workbenchIds(prefix: string, tab: WorkbenchTab): { tab: string; panel: string } {
	return tabRowIds(prefix, tab);
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
	const tabs = WORKBENCH_TABS.map((tab) => ({ id: tab.id, label: tabLabel(tab.id, { trash: trashCount }), ...(tab.id === 'trash' ? { reserve: tabLabel('trash', { trash: 888 }) } : {}) }));
	return <TabRow tabs={tabs} value={value} onSelect={onChange} activation="manual" label="Collection views" idPrefix={idPrefix} marker="workbench-tabs" />;
}

export default WorkbenchTabs;
