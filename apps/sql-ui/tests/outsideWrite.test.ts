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
// AN OUTSIDE WRITE MAKES THE DATA PAGE COUNT AGAIN (DA-R2 M2)
// =============================================================================
//
// The Data page caches its exact total per filter (sql/estimate.ts), and a
// write it did not make itself left that total in place: a DELETE run on the
// Query page (or rerun from History), or a designer Apply, and the pager
// kept the old total and offered empty trailing pages. The workbench now
// keeps one write epoch per connection: the Query page and the designer bump
// it when something may have changed rows, and the Data page takes it as
// `countEpoch`, which forgets the cached totals. The views have no DOM
// harness, so the chain is the pure pieces plus the wiring in the source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mayHaveChangedRows } from '../src/sql/batch';
import type { StatementRun } from '../src/sql/batch';
import { applyEstimate, applyTotal, emptyCountCache, invalidateTotals, planCount } from '../src/sql/estimate';
import type { CountRequest } from '../src/sql/estimate';

const src = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf8');

/** A finished statement. */
const run = (over: Partial<StatementRun>): StatementRun => ({ index: 0, sql: 'DELETE FROM orders WHERE id = 1', kind: 'write', verb: 'DELETE', outcome: 'affected', ...over } as StatementRun);

/** An unfiltered page request on a small table. */
const request: CountRequest = { key: 'orders|', filtered: false, executeAllowed: true, forceExact: false, canProbe: true };

describe('mayHaveChangedRows: which finished statements count as a write', () => {
	it('a write, a schema change or a call that ran, returned rows (RETURNING) or was not waited for', () => {
		assert.equal(mayHaveChangedRows(run({})), true);
		assert.equal(mayHaveChangedRows(run({ outcome: 'rows' })), true, 'DELETE … RETURNING');
		assert.equal(mayHaveChangedRows(run({ outcome: 'abandoned' })), true, 'Stop waiting: it may still commit');
		assert.equal(mayHaveChangedRows(run({ kind: 'ddl', sql: 'TRUNCATE orders', outcome: 'affected' })), true);
		assert.equal(mayHaveChangedRows(run({ kind: 'other', sql: 'CALL purge()', outcome: 'affected' })), true);
	});

	it('not a read, a failed statement (it committed nothing), or one never sent', () => {
		assert.equal(mayHaveChangedRows(run({ kind: 'read', sql: 'SELECT 1', outcome: 'rows' })), false);
		assert.equal(mayHaveChangedRows(run({ outcome: 'error' })), false);
		assert.equal(mayHaveChangedRows(run({ outcome: 'skipped' })), false);
		assert.equal(mayHaveChangedRows(run({ outcome: 'pending' })), false);
	});
});

describe('the Data page\'s cached exact total is not reused after an outside write', () => {
	it('a cached exact total is reused, until a write the page did not make bumps the epoch', () => {
		const counted = applyTotal(applyEstimate(emptyCountCache('orders'), 500), request.key, 42, true);
		assert.equal(planCount(counted, request), 'reuse', 'paging reuses the total');
		// The Query page ran `DELETE FROM orders WHERE id = 1`: the workbench
		// bumps its epoch, and the Data page forgets its totals on the change.
		assert.equal(mayHaveChangedRows(run({})), true);
		assert.equal(planCount(invalidateTotals(counted), request), 'count', 'the next page counts again');
	});

	it('the workbench keeps the epoch and hands it to the Data page, and both writers to it', () => {
		const view = src('views/ConnectionView.tsx');
		assert.match(view, /const \[writeEpoch, setWriteEpoch\] = useState\(0\);/);
		assert.match(view, /const noteWrite = useCallback\(\(\): void => \{ setWriteEpoch\(\(n\) => n \+ 1\); \}, \[\]\);/);
		assert.match(/<TableDataView[^>]*>/.exec(view)?.[0] ?? '', /countEpoch=\{writeEpoch\}/);
		assert.match(/<TableDesignView[^>]*>/.exec(view)?.[0] ?? '', /onWrite=\{noteWrite\}/);
		assert.match(view, /<QueryView[\s\S]*?onWrite=\{noteWrite\}[\s\S]*?\/>/);
	});

	it('the Query page flags a possible write per statement and reports it once per batch, also after Stop waiting (History reruns go the same way)', () => {
		const query = src('views/QueryView.tsx');
		assert.match(query, /record: \(run\) => \{\s*if \(mayHaveChangedRows\(run\)\) wroteRef\.current = true;\s*env\.history\.record\(endpoint, toHistoryEntry\(run\)\);\s*\},/);
		assert.match(query, /onFinished: \(info, opts\) => \{[\s\S]*?reportWrite\(\);\s*\},/);
		assert.match(query, /onStopped: \(\) => \{\s*reportWrite\(\);/);
	});

	it('the designer reports one when anything may have run', () => {
		const design = src('views/TableDesignView.tsx');
		assert.match(design, /if \(failure === null \|\| failure\.committed > 0 \|\| failure\.unknown\) onWrite\?\.\(\);/);
	});

	it('the Data page forgets its totals when the epoch changes, as before', () => {
		const data = src('views/TableDataView.tsx');
		assert.match(data, /if \(epochSeen\.current === countEpoch\) return;\s*epochSeen\.current = countEpoch;\s*countRef\.current = invalidateTotals\(countRef\.current\);/);
	});
});
