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
// MAP - BUDGETS (the layout limits, shared by the worker and the main thread)
// =============================================================================
//
// Plain constants with no imports, so the main thread (toolbar, client,
// protocol) can read them without pulling the layouts or d3-force out of the
// worker chunk.
// =============================================================================

/** Ticks of the neighbour-graph layout (d3's own default). */
export const FORCE_TICKS = 300;

/** Wall-clock budget of the neighbour-graph layout. */
export const FORCE_BUDGET_MS = 15_000;

/** The most points t-SNE accepts. */
export const TSNE_MAX_POINTS = 1000;

/** Wall-clock budget of a t-SNE run. */
export const TSNE_BUDGET_MS = 20_000;

/** Iterations of a full t-SNE run. */
export const TSNE_ITERATIONS = 750;
