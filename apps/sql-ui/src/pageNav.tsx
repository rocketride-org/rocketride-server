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
// PAGE NAV — in-connection page navigation (pages instead of inner documents)
// =============================================================================
//
// The connection workbench hosts query / data / design surfaces as PAGES of
// one document (no inner tab strip). Everything that used to open an inner
// document for them (the record drawer's buttons, the history panel's "open
// in new query") consults this context first: inside a connection workbench
// it switches the page; outside one (a legacy standalone query/table/design
// document) the context is absent and the caller falls back to the old
// document-opening path.
// =============================================================================

import { createContext, useContext } from 'react';

/** A query-page seed (all optional — a bare seed is a fresh empty query). */
export interface SqlQuerySeed {
	/** Editor text to start with. */
	sql?: string;
	/** Display label (results strip, announcements). */
	label?: string;
	/** 'generated' marks app-written SQL (review-then-run banner). */
	origin?: 'generated';
}

/** In-connection page navigation (see the file header). */
export interface SqlPageNav {
	/** Shows the QUERY page, seeded (replaces the page's current query). */
	openQuery(seed: SqlQuerySeed): void;
	/** Shows the DATA page for one table. */
	openTableData(table: string): void;
	/** Shows the DESIGN page for one table (null = create-table draft). */
	openDesign(table: string | null): void;
}

const SqlPageNavContext = createContext<SqlPageNav | null>(null);

/** The connection workbench's provider. */
export const SqlPageNavProvider = SqlPageNavContext.Provider;

/**
 * The enclosing connection workbench's page navigation, or null outside one
 * (legacy standalone documents — callers fall back to opening documents).
 */
export function useSqlPageNav(): SqlPageNav | null {
	return useContext(SqlPageNavContext);
}
