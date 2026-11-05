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
// FILTER HINT — the "+ Filter" form says which matches ignore case, truly
// =============================================================================
//
// Search, contains and starts with run ILIKE (PostgreSQL, ClickHouse) or
// LOWER() LIKE LOWER() (MySQL), so they ignore case. Equals and not equals
// send a plain `=` / `<>`, which compares exactly on PostgreSQL and ClickHouse
// and as the column's collation does on MySQL (the usual ones ignore case).
// The live run found the form claiming that every text match ignores case:
// `note equals NOTE 2` returned 0 rows on PostgreSQL. The hint now says what
// each engine does, and the operators are unchanged.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SqlDialect } from '../src/connect';
import { chipPredicate, textMatchHint } from '../src/sql/filters';

const chips = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'FilterChips.tsx'), 'utf8');
const data = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'TableDataView.tsx'), 'utf8');
const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

/**
 * A chip's predicate with numbered placeholders.
 *
 * @param dialect - The dialect.
 * @param op - The operator.
 * @returns The predicate.
 */
function predicate(dialect: SqlDialect, op: 'eq' | 'contains' | 'startsWith'): string {
	let n = 0;
	return chipPredicate(dialect, '"note"', { column: 'note', op, value: 'NOTE 2' }, () => `$${++n}`);
}

describe('textMatchHint', () => {
	it('on PostgreSQL: search, contains and starts with ignore case; equals compares exactly', () => {
		assert.equal(textMatchHint('postgres'), 'Search, contains and starts with ignore upper and lower case. Equals and not equals compare exactly, as PostgreSQL does.');
	});

	it('on MySQL: equals follows the column\'s collation, and the usual ones ignore case', () => {
		assert.equal(textMatchHint('mysql'), 'Search, contains and starts with ignore upper and lower case. Equals and not equals compare as the column\'s collation does; MySQL\'s usual collations ignore case too.');
	});

	it('on ClickHouse: equals compares exactly', () => {
		assert.equal(textMatchHint('clickhouse'), 'Search, contains and starts with ignore upper and lower case. Equals and not equals compare exactly.');
	});

	it('before the database type is known, it claims nothing about case', () => {
		assert.equal(textMatchHint('unknown'), 'Text matches compare as the database does until the database is known.');
	});

	it('matches what the predicates send: ILIKE / LOWER for the text operators, a plain = for equals', () => {
		assert.equal(predicate('postgres', 'eq'), '"note" = $1');
		assert.match(predicate('postgres', 'contains'), /ILIKE/);
		assert.match(predicate('postgres', 'startsWith'), /ILIKE/);
		assert.match(predicate('mysql', 'contains'), /LOWER\(.*\) LIKE LOWER/);
		assert.match(predicate('clickhouse', 'contains'), /ILIKE/);
		assert.equal(predicate('mysql', 'eq'), '"note" = $1');
	});
});

describe('the filter form and the README say it', () => {
	it('the form shows the dialect\'s hint, and no longer claims every match ignores case', () => {
		assert.doesNotMatch(chips, /Text matches ignore upper and lower case/);
		assert.match(chips, /\{textMatchHint\(dialect\)\}/);
		assert.match(data, /<FilterChips[\s\S]*?dialect=\{dialect\}/);
	});

	it('the README says equals compares exactly', () => {
		assert.match(readme, /\*\*contains\*\* and \*\*starts with\*\* ignore case too; \*\*equals\*\* and \*\*not equals\*\* compare exactly, as the database does/);
		assert.doesNotMatch(readme, /Text matches ignore upper and lower case/);
	});
});
