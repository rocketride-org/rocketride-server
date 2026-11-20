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
// SQL-UI — PAGE FRAME (which workbench pages draw their own chrome)
// =============================================================================
//
// The connection workbench puts a header above its pages. Query, Data and
// Design each start with a header of their own (it names the query or table
// and holds the page's buttons), so the workbench header above them made two
// stacked headers. They also pad their own body, so the panel around them
// adds none.
// =============================================================================

/** The pages that draw their own header and padding. */
const SELF_FRAMED_PAGES: ReadonlySet<string> = new Set(['query', 'data', 'design']);

/**
 * Whether a page draws its own header and body padding.
 *
 * @param page - The workbench page id.
 * @returns True for Query, Data and Design.
 */
export function pageHasOwnHeader(page: string): boolean {
	return SELF_FRAMED_PAGES.has(page);
}

/**
 * Whether the workbench header (connection name, Refresh Schema, New Query)
 * shows above a page.
 *
 * @param page - The workbench page id.
 * @returns True for Overview, Insights and Diagram.
 */
export function showsWorkbenchHeader(page: string): boolean {
	return !pageHasOwnHeader(page);
}
