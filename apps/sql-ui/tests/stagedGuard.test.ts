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
// STAGED GUARD — opening another table's data asks before staged edits go
// =============================================================================
//
// Review P4 R2-M2: a new data seed remounts the Data page and drops its staged
// edits. The page registers how many it holds (sql/stagedGuard.ts), and the
// workbench's openTableData asks first when there are any: from the Overview,
// the diagram, and the record drawer's Show rows alike.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { leaveDataText, registerStagedCount, stagedCount } from '../src/sql/stagedGuard';

const SRC = path.resolve(__dirname, '..', 'src');

describe('the staged-edits guard', () => {
	it('a data page registers its count; none registered is none staged; unregistering forgets it', () => {
		assert.equal(stagedCount('p:s:n'), 0);
		let staged = 3;
		const off = registerStagedCount('p:s:n', () => staged);
		assert.equal(stagedCount('p:s:n'), 3);
		staged = 0;
		assert.equal(stagedCount('p:s:n'), 0);
		assert.equal(stagedCount('p:s:other'), 0);
		off();
		staged = 5;
		assert.equal(stagedCount('p:s:n'), 0);
	});

	it('asks in plain words', () => {
		assert.equal(leaveDataText(3, 'customers'), 'You have 3 staged changes. Discard them and open customers?');
		assert.equal(leaveDataText(1, 'orders'), 'You have 1 staged change. Discard it and open orders?');
	});

	it('the workbench asks before a new data seed when the page holds staged changes; the page registers its count', () => {
		const workbench = fs.readFileSync(path.join(SRC, 'views', 'ConnectionView.tsx'), 'utf8');
		assert.match(workbench, /const staged = stagedCount\(endpoint\.key\);\s*if \(staged > 0\) \{\s*setLeaveAsk\(\{ table, chips: chips \?\? \[\], staged \}\);\s*return;\s*\}/);
		assert.match(workbench, /message=\{leaveDataText\(leaveAsk\.staged, leaveAsk\.table\)\}/);
		const page = fs.readFileSync(path.join(SRC, 'views', 'TableDataView.tsx'), 'utf8');
		assert.match(page, /useEffect\(\(\) => registerStagedCount\(endpoint\.key, \(\) => editsRef\.current\.entries\.length\), \[endpoint\.key\]\);/);
	});
});
