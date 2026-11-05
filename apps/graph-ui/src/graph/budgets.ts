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
// GRAPH - BUDGETS (one constant per limit, each named in the UI when it applies)
// =============================================================================

/** Nodes drawn when a result first opens. */
export const INITIAL_NODES = 300;

/** The most nodes the canvas ever holds. */
export const MAX_NODES = 1000;

/** The most relationships the canvas ever holds. */
export const MAX_RELATIONSHIPS = 2000;

/** New neighbours added by one expansion, not counting nodes already shown. */
export const MAX_NEW_NEIGHBORS = 100;

/** Above this many nodes the layout is a static, off-main-thread computation. */
export const STATIC_LAYOUT_ABOVE = 100;

/** Nodes fetched by a label preview. */
export const PREVIEW_LIMIT = 25;

/** The deepest path the app will search for. */
export const PATH_MAX_DEPTH = 10;

/** Graph elements the node allows in one response (mirrors the node's budget). */
export const NODE_ELEMENT_BUDGET = 10000;

/** The row-limit choices in the editor header (`null` = All, bounded by the node's cap). */
export const ROW_LIMIT_CHOICES: ReadonlyArray<number | null> = [200, 1000, null];

/** The default row limit. */
export const DEFAULT_ROW_LIMIT = 1000;
