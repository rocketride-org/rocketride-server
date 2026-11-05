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
// HISTORY TITLE — a history row is named by its first line of code
// =============================================================================
//
// A history row shows one line of its statement. Generated previews start
// with `-- Generated preview: review, then Run.`, and that comment is part of
// what runs and is stored, so the first line of TEXT named every generated
// statement the same. The title is the first line once comments are removed,
// read with the connection's own comment rules (`#` is a comment on MySQL and
// ClickHouse only), and falls back to the raw first line for text that is
// nothing but comments.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SqlDialect } from '../src/connect';
import { historyTitle } from '../src/sql/batch';

const DIALECTS: SqlDialect[] = ['postgres', 'mysql', 'clickhouse', 'unknown'];
const panel = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'HistoryPanel.tsx'), 'utf8');

describe('historyTitle', () => {
	it('skips a leading line comment on every dialect', () => {
		for (const dialect of DIALECTS) {
			assert.equal(historyTitle('-- Generated preview: review, then Run.\nSELECT * FROM orders LIMIT 100;', dialect), 'SELECT * FROM orders LIMIT 100;', dialect);
		}
	});

	it('skips leading block comments, one line or several, on every dialect', () => {
		for (const dialect of DIALECTS) {
			assert.equal(historyTitle('/* nightly fix */ UPDATE orders SET status = 1 WHERE id = 7', dialect), 'UPDATE orders SET status = 1 WHERE id = 7', dialect);
			assert.equal(historyTitle('/*\n * ticket 482\n */\n\nDELETE FROM carts WHERE id = 3', dialect), 'DELETE FROM carts WHERE id = 3', dialect);
		}
	});

	it('skips `#` comments on MySQL and ClickHouse only', () => {
		assert.equal(historyTitle('# cleanup\nSELECT 1', 'mysql'), 'SELECT 1');
		assert.equal(historyTitle('# cleanup\nSELECT 1', 'clickhouse'), 'SELECT 1');
		assert.equal(historyTitle('# cleanup\nSELECT 1', 'postgres'), '# cleanup');
	});

	it('drops a trailing comment on the first line of code', () => {
		assert.equal(historyTitle('SELECT 1 -- why', 'postgres'), 'SELECT 1');
	});

	it('keeps comment markers inside string literals', () => {
		assert.equal(historyTitle("SELECT '-- not a comment' AS a", 'postgres'), "SELECT '-- not a comment' AS a");
	});

	it('falls back to the raw first line for text that is only comments', () => {
		assert.equal(historyTitle('-- just a note\n-- and another', 'postgres'), '-- just a note');
		assert.equal(historyTitle('\n  /* only this */  \n', 'mysql'), '/* only this */');
	});

	it('is the trimmed text for a one-line statement', () => {
		assert.equal(historyTitle('   SELECT 1   ', 'postgres'), 'SELECT 1');
	});
});

describe('HistoryPanel titles', () => {
	it('names rows with historyTitle and the connection\'s dialect', () => {
		assert.doesNotMatch(panel, /function firstLine\(/);
		assert.match(panel, /const dialect = useSchema\(endpoint\.key\)\.dialect;/);
		assert.match(panel, /historyTitle\(entry\.sql, dialect\)/);
		assert.match(panel, /rowLabel\(entry, dialect\)/);
	});
});
