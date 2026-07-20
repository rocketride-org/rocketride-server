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
// FROZEN shell-api contract — ShellApiV0 — GENESIS (empty) baseline
// =============================================================================
// v0 carries NO surface on purpose: it is the empty seed the freeze tool appends
// onto and the base type the shell-api barrels reference. The first real,
// shippable contract is v1. Because the genesis binds nothing, it can never be
// broken by later changes — every real member is added at v1 or beyond.
// Do not edit by hand.
// =============================================================================

// ===== BEGIN FROZEN BUNDLE — do not edit =====
declare const shellApi: {};
export type ShellApiShape = typeof shellApi;
// ===== END FROZEN BUNDLE =====
export type ShellApiV0 = ShellApiShape;
