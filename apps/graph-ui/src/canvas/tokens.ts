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
// CANVAS - COLOUR TOKENS (which shell token each thing on the canvas is drawn with)
// =============================================================================
//
// One place names them, so the stylesheet, the edge layer and the inspector cannot drift
// apart, and a test measures exactly these against every shipped theme (tests/a11y.contrast).
//
// The canvas sits on `--rr-bg-default`, and panels and the editor on `--rr-bg-paper`; every
// pair below must clear its minimum against BOTH, in every theme.
//
// WHY NOT `--rr-brand`: in RocketRide Light it is #00b9ec, which is 1.9:1 against the page. A
// highlighted path drawn in it was FAINTER than an ordinary relationship. `--rr-border-focus`
// is the shell's own colour for "this is the active thing"; it clears 3:1 in all six themes.
// =============================================================================

/** The accent: a highlighted (found-path or selected-end) relationship, the selection ring, the focus ring. Graphics: at least 3:1. */
export const ACCENT_TOKEN = '--rr-border-focus';

/** An ordinary relationship line. Graphics: at least 3:1. */
export const EDGE_TOKEN = '--rr-text-secondary';

/** Relationship type labels and node captions, drawn as small text on the canvas. At least 4.5:1. */
export const CANVAS_TEXT_TOKEN = '--rr-text-primary';

/** Text of a label chip in the inspector. At least 4.5:1. */
export const CHIP_TEXT_TOKEN = '--rr-text-primary';

/** The backgrounds the canvas and its panels sit on. */
export const CANVAS_SURFACES = ['--rr-bg-default', '--rr-bg-paper'] as const;

/** WCAG 1.4.3: normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** WCAG 1.4.11: graphical objects and focus indicators. */
export const MIN_GRAPHIC_CONTRAST = 3;
