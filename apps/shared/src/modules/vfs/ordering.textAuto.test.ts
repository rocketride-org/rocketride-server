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
// ORDERING TESTS — a text tab in auto mode: typing, queued saves, the dialog, Reload, Overwrite, close and a tab move
// =============================================================================

/**
 * One editor document exploration, in a file of its own so the test runner
 * runs it in parallel with the others: the real text tab (fileDocument.ts) in
 * auto mode. The steps and the rules are in ordering.harness.ts
 * (checkDocumentOrders).
 */

import { test } from 'node:test';

import { checkDocumentOrders } from './ordering.harness';

test('with a text tab in auto mode, no order of typing, saves that queue, Discard mine, Reload, Overwrite, close, a tab move, a failed write drops, erases or keeps from the file what the user chose, or runs what the file does not hold', () => checkDocumentOrders('text', true));
