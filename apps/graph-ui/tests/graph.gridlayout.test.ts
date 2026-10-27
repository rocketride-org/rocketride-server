// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// GRID LAYOUTS: WHAT A SAVED RESULTS LAYOUT MAY RESTORE
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IDataGridPersistence } from 'shell';
import { columnSignature, nextMountNonce, resultLayoutKey, MIN_SAVED_WIDTH, RESULT_LAYOUTS, createSessionLayouts, guardLayouts, layoutRulesFor, sanitizeColumnLayout } from '../src/graph/gridLayout';

/** The result grid's columns: generated keys, no width (all flexible). */
const RESULT = [{ field: 'c0' }, { field: 'c1' }, { field: 'c2' }];

/** What a grid built in a hidden tab saved. */
const CRUSHED = [{ field: 'c0', width: 40, visible: true }, { field: 'c1', width: 40, visible: true }, { field: 'c2', width: 40, visible: false }];

/** A persistence over a map, recording writes. */
function memory(seed: Record<string, unknown> = {}): { grids: IDataGridPersistence; store: Map<string, unknown>; cleared: string[] } {
	const store = new Map(Object.entries(seed));
	const cleared: string[] = [];
	return {
		store,
		cleared,
		grids: {
			read: (tableId, type) => store.get(`${tableId}/${type}`) ?? false,
			write: (tableId, type, data) => { store.set(`${tableId}/${type}`, data); },
			clear: (tableId) => { cleared.push(tableId); },
		},
	};
}

test('result columns all flex, so no width is kept for any of them', () => {
	const rules = layoutRulesFor(RESULT);
	assert.deepEqual(rules, { fixedWidths: [], alwaysVisible: [] });
	assert.deepEqual(sanitizeColumnLayout(CRUSHED, rules), [{ field: 'c0', visible: true }, { field: 'c1', visible: true }, { field: 'c2', visible: false }]);
});

test('a width under the minimum is dropped for a column the code sizes, a wider one is kept', () => {
	assert.equal(MIN_SAVED_WIDTH, 60);
	const rules = layoutRulesFor([{ field: 'a', width: 100 }, { field: 'b', width: 100 }]);
	assert.deepEqual(sanitizeColumnLayout([{ field: 'a', width: 12 }, { field: 'b', width: 300 }], rules), [{ field: 'a' }, { field: 'b', width: 300 }]);
});

test('anything that is not a column list is left alone', () => {
	assert.equal(sanitizeColumnLayout(false, layoutRulesFor(RESULT)), false);
	assert.deepEqual(sanitizeColumnLayout({ x: 1 }, layoutRulesFor(RESULT)), { x: 1 });
});

test('the guard heals a crushed layout as it is read, and never writes one back; other kinds pass through', () => {
	const { grids, store } = memory({ 'graph-results-t/columns': CRUSHED, 'graph-results-t/sort': [{ column: 'c0', dir: 'asc' }] });
	const guarded = guardLayouts(grids, layoutRulesFor(RESULT));
	assert.deepEqual(guarded.read('graph-results-t', 'columns'), [{ field: 'c0', visible: true }, { field: 'c1', visible: true }, { field: 'c2', visible: false }]);
	assert.deepEqual(store.get('graph-results-t/columns'), CRUSHED, 'reading did not write the healed copy back');
	assert.deepEqual(guarded.read('graph-results-t', 'sort'), [{ column: 'c0', dir: 'asc' }]);
	guarded.write('graph-results-t', 'columns', [{ field: 'c0', width: 40, visible: true }]);
	assert.deepEqual(store.get('graph-results-t/columns'), [{ field: 'c0', visible: true }], 'a crushed width is never saved');
	guarded.clear('graph-results-t');
});

test('the results grid goes through the guard', () => {
	const views = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'ResultViews.tsx'), 'utf8');
	assert.match(views, /guardLayouts\(RESULT_LAYOUTS, layoutRulesFor\(columns\)\)/);
	assert.match(views, /persistence=\{persistence\}/);
});

test('a sort or a hidden column on a result stays in the page session and never reaches the env\'s persistence', () => {
	const env = memory();
	const results = guardLayouts(RESULT_LAYOUTS, layoutRulesFor(RESULT));
	results.write('graph-results-k-q1-1', 'sort', [{ column: 'c1', dir: 'desc' }]);
	results.write('graph-results-k-q1-1', 'columns', [{ field: 'c0', visible: false }]);
	assert.deepEqual(results.read('graph-results-k-q1-1', 'sort'), [{ column: 'c1', dir: 'desc' }], 'kept while the page is open');
	assert.deepEqual(results.read('graph-results-k-q1-1', 'columns'), [{ field: 'c0', visible: false }]);
	assert.equal(env.store.size, 0, 'nothing was written to the env');
	assert.equal(env.grids.read('graph-results-k-q1-1', 'sort'), false);
	results.clear('graph-results-k-q1-1');
	assert.equal(results.read('graph-results-k-q1-1', 'sort'), false);
});

test('the session store hands out copies: what the grid writes into them never changes what is kept', () => {
	const store = createSessionLayouts();
	const blob = [{ column: 'a', dir: 'asc' }];
	store.write('t', 'sort', blob);
	(blob[0] as Record<string, unknown>).tabulator = 'x';
	const read = store.read('t', 'sort') as Array<Record<string, unknown>>;
	assert.equal(read[0].tabulator, undefined);
	read[0].extra = 1;
	assert.deepEqual(store.read('t', 'sort'), [{ column: 'a', dir: 'asc' }]);
	store.clear('t');
});

test('two mounts with the same tab id and result counter do not share a layout key, and a result with other columns does not either', () => {
	const first = resultLayoutKey('k-q1-1', nextMountNonce(), ['a', 'b']);
	const second = resultLayoutKey('k-q1-1', nextMountNonce(), ['a', 'b']);
	assert.notEqual(first, second, 'a reopened workbench restarts its counters');
	const nonce = nextMountNonce();
	assert.equal(resultLayoutKey('k-q1-1', nonce, ['a', 'b']), resultLayoutKey('k-q1-1', nonce, ['a', 'b']), 'stable within one mount');
	assert.notEqual(resultLayoutKey('k-q1-1', nonce, ['a', 'b']), resultLayoutKey('k-q1-1', nonce, ['a', 'c']));
	assert.notEqual(columnSignature(['a', 'bc']), columnSignature(['ab', 'c']));
	assert.match(first, /^graph-results-k-q1-1-m\d+-[0-9a-f]{8}$/);
});

test('the results Table builds its key from the mount nonce and the columns', () => {
	const views = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'ResultViews.tsx'), 'utf8');
	assert.match(views, /useState\(nextMountNonce\)/);
	assert.match(views, /resultLayoutKey\(tableKey, nonce, result\.columns\)/);
	assert.match(views, /tableId=\{tableId\}/);
});
