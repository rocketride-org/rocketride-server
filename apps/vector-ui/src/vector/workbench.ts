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
// entry (`queryMode`, `queryPrefill`), as does a request for the Documents
// tab to show one document (`openDocument`).
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
 * Another tab asks the Documents tab to show one document (Overview's Insights, a query result, the pending bar's
 * Review): Documents opens its drawer on it, then clears the request. Taken once, by its nonce.
 */
export interface IOpenDocumentRequest {
	nonce: string;
	objectId: string;
}

/** Nonces handed out on this page. */
let nonces = 0;

/**
 * A new nonce for a request handed to another tab (taken once).
 *
 * @param kind - What it asks ("query", "document").
 * @returns The nonce.
 */
export function workbenchNonce(kind: string): string {
	nonces += 1;
	return `${kind}-${nonces}`;
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

/**
 * Where a key moves the focus along a row of tabs (APG tabs: Left and Right wrap, Home and End). The tab row
 * activates on Enter or Space only, so moving along it never opens a tab that calls the store (the Map samples).
 *
 * @param key - `KeyboardEvent.key`.
 * @param index - The focused tab.
 * @param count - How many tabs.
 * @returns The tab to focus, or null for a key that does not move.
 */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	switch (key) {
		case 'ArrowRight':
			return (index + 1) % count;
		case 'ArrowLeft':
			return (index - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

/**
 * B1(b): whether to probe the store again because fresh stats say the collection exists while the probe read at
 * discovery said it does not. Once per disagreement: a store whose probe keeps disagreeing is not asked again until
 * the two agree (or the connection changes), whatever the 15 s quick tick brings.
 *
 * @param tried - The connection already probed for the disagreement in progress, or null.
 * @param disagree - Whether the stats and the probe disagree now.
 * @param key - The connection.
 * @returns Whether to probe now, and the connection probed for (null once they agree).
 */
export function reprobeFor(tried: string | null, disagree: boolean, key: string): { probe: boolean; tried: string | null } {
	if (!disagree) return { probe: false, tried: null };
	if (tried === key) return { probe: false, tried };
	return { probe: true, tried: key };
}

/** What {@link panelOf} reads of an element. */
export interface IPanelLookup {
	closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * The workbench panel an element is in (its `data-workbench-panel`), or null outside every panel.
 *
 * @param element - The element (`document.activeElement`), or null.
 * @returns The panel's tab id, or null.
 */
export function panelOf(element: IPanelLookup | null): string | null {
	return element?.closest('[data-workbench-panel]')?.getAttribute('data-workbench-panel') ?? null;
}

/**
 * Whether a tab switch left the focus stranded in a panel that is now hidden (a "Show on map" or a quick action
 * inside a panel switched the tab): the focus must then move to the tab row.
 *
 * @param element - `document.activeElement`.
 * @param shown - The tab now shown.
 * @returns True when the focus is inside another tab's panel.
 */
export function focusStranded(element: IPanelLookup | null, shown: WorkbenchTab): boolean {
	const panel = panelOf(element);
	return panel !== null && panel !== shown;
}
