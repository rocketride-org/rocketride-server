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
// ROW LIMIT "ALL" — choosing it says what it costs
// =============================================================================
//
// The Query page's row limit offers All. The node refuses a result over its
// `max_execute_rows` cap (25,000 unless the pipeline sets it) rather than
// truncating it, and a large result is slow to fetch and render, so choosing
// All says so, in text and to a screen reader. The view has no DOM harness
// here, so its wiring is checked on the source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_ROWS_WARNING } from '../src/sql/batch';

const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

describe('the All row limit', () => {
	it('warns in plain words, naming the node\'s cap', () => {
		assert.equal(ALL_ROWS_WARNING, 'All asks for every row. The node refuses results over its cap (25,000 unless the pipeline sets max_execute_rows) and may be slow.');
	});

	it('shows the warning while All is chosen, and announces it when it is picked', () => {
		assert.match(view, /\{limit === 'All' && \(\s*<div style=\{styles\.meta\}>[\s\S]*?\{ALL_ROWS_WARNING\}/);
		assert.match(view, /if \(next === 'All'\) announce\(ALL_ROWS_WARNING\);/);
	});
});
