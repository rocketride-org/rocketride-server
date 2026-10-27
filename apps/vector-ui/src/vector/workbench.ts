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
// VECTOR - THE WORKBENCH'S TABS (pure)
// =============================================================================
//
// A connection's console is one document with inner tabs: Overview,
// Documents, Query, Map, Collection and Trash. Which one shows is the
// connection's `entry.tab` (adapters/connections.ts), so the map's and the
// chat's actions can switch it from anywhere (adapters/consoleActions.ts).
// The Query tab's mode and the question handed to it live beside it in the
// entry (`queryMode`, `queryPrefill`).
// =============================================================================

import type { VectorKey } from '../contract/types';
import { formatCount } from './stats';

/** The inner tabs of a connection's console. */
export type WorkbenchTab = 'overview' | 'documents' | 'query' | 'map' | 'collection' | 'trash';

/** The tabs in the order the tab row shows them. */
export const WORKBENCH_TABS: ReadonlyArray<{ id: WorkbenchTab; label: string }> = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'documents', label: 'Documents' },
	{ id: 'query', label: 'Query' },
	{ id: 'map', label: 'Map' },
	{ id: 'collection', label: 'Collection' },
	{ id: 'trash', label: 'Trash' },
];

/** The tab a connection opens on. */
export const DEFAULT_TAB: WorkbenchTab = 'overview';

/** The Overview tab's views. */
export type OverviewView = 'summary' | 'charts' | 'insights';

/** The Query tab's modes. */
export type QueryMode = 'search' | 'compare' | 'ask';

/** A question handed to the Query tab from elsewhere (taken once, by its nonce). */
export interface IQueryPrefill {
	/** Taken once: a new nonce is a new request, even for the same question. */
	nonce: string;
	question: string;
	/** The mode to run it in (absent: the tab's current mode). */
	mode?: QueryMode;
	/** The chunks it is about (a chat answer's sources, a chunk used as the query). */
	keys?: VectorKey[];
}

/**
 * A tab's label in the tab row: the Trash adds the store's count of trashed documents when it reports one.
 *
 * @param tab - The tab.
 * @param counts - `trash`: documents in the trash as the store counts them (stats.deletedDocuments), or null.
 * @returns The label.
 */
export function tabLabel(tab: WorkbenchTab, counts: { trash: number | null }): string {
	const label = WORKBENCH_TABS.find((t) => t.id === tab)?.label ?? tab;
	if (tab === 'trash' && counts.trash !== null) return `${label} (${formatCount(counts.trash)})`;
	return label;
}
