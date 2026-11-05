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
// VECTOR - CHART TOKENS (which shell token each part of the collection charts is drawn with)
// =============================================================================
//
// One place names them, so components/StatsCharts.tsx and the contrast test
// (tests/a11y.contrast.charts.test.ts) cannot drift apart. The charts sit in
// the stats strip, on --rr-bg-default, and are measured on --rr-bg-paper too,
// in all six shipped themes. Bars are --rr-chart-blue (at least 3:1 on both
// surfaces everywhere); the bar the scope selected, the focus ring and the
// baseline use the console's accent and text tokens; every word is the
// console's one text token. --rr-text-secondary and the status colours are
// never used: they fall below the minimum in some theme.
// =============================================================================

/** The surfaces the charts are drawn on. */
export const CHART_SURFACES = ['--rr-bg-default', '--rr-bg-paper'] as const;

/** Every bar. Graphics: 3:1. */
export const CHART_BAR_TOKEN = '--rr-chart-blue';

/** The bar of the bin the scope selected, and the focus ring of a bar. Graphics: 3:1. */
export const CHART_ACTIVE_TOKEN = '--rr-border-focus';

/** The baseline under the bars. Graphics: 3:1. */
export const CHART_AXIS_TOKEN = '--rr-text-primary';

/** Titles, captions, axis labels. Text: 4.5:1. */
export const CHART_TEXT_TOKEN = '--rr-text-primary';

/** The skeleton bars while the directory loads (decorative: a status line says "Loading…"). */
export const CHART_SKELETON_TOKEN = '--rr-border-input';

/** The graphics tokens the contrast test measures at 3:1. */
export const CHART_GRAPHIC_TOKENS = [CHART_BAR_TOKEN, CHART_ACTIVE_TOKEN, CHART_AXIS_TOKEN] as const;

/** The text tokens the contrast test measures at 4.5:1. */
export const CHART_TEXT_TOKENS = [CHART_TEXT_TOKEN] as const;
