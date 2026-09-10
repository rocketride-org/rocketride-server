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
// SHELL_API_VERSION — the current shell-api contract version (newest frozen)
// =============================================================================
//
// This is the SINGLE SOURCE OF TRUTH for the shell contract version, and it lives
// in its own file ON PURPOSE:
//
//  - `./builder shell:freeze` AUTO-WRITES the number here when it appends a new
//    frozen version, so bumping it is never a manual step.
//  - The app registration step (scripts/lib/registerApp.js) reads this file and
//    stamps every app's apps.json entry with `shellApiVersion`, recording the
//    shell contract each app was built against. That lets you tell, across all
//    registered apps, the lowest version still in use — and safely prune frozen
//    versions no app depends on any more.
//
// Keep this file to JUST the constant below (the freeze rewriter and the
// registration reader both parse it with a simple regex).
// =============================================================================

/** The current shell-api contract version (the newest frozen `versions/vN`). */
export const SHELL_API_VERSION = 2 as const;
