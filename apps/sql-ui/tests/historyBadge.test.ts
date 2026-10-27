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
// HISTORY — THE OUTCOME BADGE
// =============================================================================
//
// `abandoned` is stored for two things: a statement nobody waited for (Stop
// waiting), and an apply statement whose fate is not known (a lost commit
// answer, or MySQL with an engine that may keep no transactions). For a write
// either way it may or may not have been saved, and "abandoned" read as
// "nothing ran" (DA-R2 M3). The outcome type is shared with the other
// Explorers and stored as is, so the badge reads the entry's kind instead:
// stored entries, old ones included, need no change.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { outcomeBadge } from '../src/history/outcomeBadge';
import type { HistoryEntry } from '../src/history/types';
import { applyHistoryEntries } from '../src/sql/applyHistory';

const base: HistoryEntry = { id: 'h', sql: 'UPDATE t SET a = 1 WHERE id = 1', at: 1, ms: 1, outcome: 'affected', kind: 'write' };

describe('outcomeBadge', () => {
	it('a write or schema change whose answer never came is "outcome unknown", never "abandoned"', () => {
		for (const kind of ['write', 'ddl', 'other'] as const) {
			assert.deepEqual(outcomeBadge({ ...base, kind, outcome: 'abandoned' }), { variant: 'warning', label: 'outcome unknown' }, kind);
		}
	});

	it('the entries an apply records when it may have saved read that way', () => {
		const statements = [{ sql: 'UPDATE t SET a = $1 WHERE id = $2', params: [1, 2] }];
		const lost = { transactional: true, results: [], failure: { index: 0, stage: 'commit' as const, message: 'lost', committed: 0, unknown: true, rollbackConfirmed: false } };
		const entries = applyHistoryEntries(statements, lost, { dialect: 'postgres', at: 1, ms: 1 });
		assert.deepEqual(entries.map((entry) => outcomeBadge(entry).label), ['outcome unknown']);
	});

	it('a read nobody waited for is still "abandoned": it changed nothing', () => {
		assert.deepEqual(outcomeBadge({ ...base, kind: 'read', sql: 'SELECT 1', outcome: 'abandoned' }), { variant: 'muted', label: 'abandoned' });
	});

	it('the other outcomes are unchanged', () => {
		assert.deepEqual(outcomeBadge({ ...base, outcome: 'affected', affected: 3 }), { variant: 'info', label: '3 affected' });
		assert.deepEqual(outcomeBadge({ ...base, outcome: 'error' }), { variant: 'error', label: 'error' });
		assert.deepEqual(outcomeBadge({ ...base, kind: 'read', outcome: 'rows', rows: 5 }), { variant: 'success', label: '5 rows returned' });
		assert.deepEqual(outcomeBadge({ ...base, kind: 'read', outcome: 'rows', rows: 5, limit: 5 }), { variant: 'success', label: '5 rows (limit 5)' });
	});

	it('the History drawer uses it', () => {
		const panel = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'HistoryPanel.tsx'), 'utf8');
		assert.match(panel, /import \{ outcomeBadge \} from '\.\.\/history\/outcomeBadge';/);
		assert.doesNotMatch(panel, /function outcomeBadge/);
	});
});
