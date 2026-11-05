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
// SAVED QUERIES WIRING — where the buttons are, and what Open does
// =============================================================================
//
// The views have no DOM harness here, so this checks the source, as the
// other wiring suites do: "Saved" and "Save as query" sit in the query
// header, "Save as query" in each History entry's actions, and Open seeds a
// NEW query instance with the statement and runs nothing.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openQuerySeed } from '../src/components/SavedQueriesPanel';

const SRC = path.resolve(__dirname, '..', 'src');
const source = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('saved queries: the entry points', () => {
	it('the query header carries "Save as query" for the editor text and "Saved" for the drawer', () => {
		const view = source('views/QueryView.tsx');
		const header = /<ContentHeader[\s\S]*?actions=\{([\s\S]*?)\n\t\t\t\t\}\n\t\t\t\/>/.exec(view);
		assert.ok(header, 'the query header');
		assert.match(header[1]!, /<SaveQueryButton endpoint=\{endpoint\} sql=\{sql\} \/>/);
		assert.match(header[1]!, /<SavedQueriesButton endpoint=\{endpoint\} \/>/);
	});

	it('each History entry offers "Save as query" for its own statement, unless history kept only part of it', () => {
		const panel = source('components/HistoryPanel.tsx');
		const actions = /<div style=\{styles\.actions\}>([\s\S]*?)<\/div>/.exec(panel);
		assert.ok(actions, 'the entry actions');
		// A truncated entry holds the first 8 KB only: saving it would keep a statement that was never run.
		assert.match(actions[1]!, /\{!entry\.truncated && <SaveQueryButton endpoint=\{endpoint\} sql=\{entry\.sql\} small \/>\}/);
	});
});

describe('saved queries: Open makes a new query instance and runs nothing', () => {
	it('the seed is the statement and its name, never marked as written by the app', () => {
		const seed = openQuerySeed({ id: 'q1', name: 'Revenue by customer', sql: 'SELECT 1', at: 1 });
		assert.deepEqual(seed, { sql: 'SELECT 1', label: 'Revenue by customer' });
		assert.equal('origin' in seed, false);
	});

	it('Open hands the seed to the workbench\'s openQuery, which adds an instance; the drawer calls nothing that runs', () => {
		const panel = source('components/SavedQueriesPanel.tsx');
		assert.match(panel, /pageNav\.openQuery\(openQuerySeed\(query\)\);/);
		assert.doesNotMatch(panel, /getSession|\.execute\(|runTargets|onRerun|runOne|runAll/);
		// The workbench's openQuery adds a query instance rather than replacing one.
		const workbench = source('views/ConnectionView.tsx');
		assert.match(workbench, /openQuery: addQuery,/);
		assert.match(workbench, /setQueries\(\(prev\) => \[\.\.\.prev, \{ id, label: seed\.label \?\? `Query \$\{id\}`, seed \}\]\)/);
	});

	it('the drawer shows where saved queries are kept, every time it is open', () => {
		const panel = source('components/SavedQueriesPanel.tsx');
		assert.match(panel, /const privacyNotice = saved\.usePrivacyNotice\(\);/);
		assert.match(panel, /<div style=\{styles\.notice\}>\{privacyNotice\}<\/div>/);
	});
});
