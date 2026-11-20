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
// EXPLORER DEV TOOL — GRID LAYOUTS IN A DEV-TOOL MOUNT (session only)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IDataGridPersistence } from 'shell';
import { createCopyingGridPersistence, createSessionGridPersistence } from './gridPersistence';
import { tabulatorSetSort } from './testing';
import type { IGridHostPrefs as IHostPrefs } from './testing';

/**
 * The shell's grid config channel as the web host answers it: a read hands
 * out the stored blob BY REFERENCE, and a write keeps the blob it is given.
 *
 * @param prefs - The host's prefs.
 * @returns The channel.
 */
function hostChannel(prefs: IHostPrefs): IDataGridPersistence {
	return {
		read(tableId, type) {
			const layout = prefs.tableLayouts[tableId];
			return layout && type in layout ? layout[type] : false;
		},
		write(tableId, type, blob) {
			prefs.tableLayouts[tableId] = { ...prefs.tableLayouts[tableId], [type]: blob };
		},
		clear(tableId) {
			delete prefs.tableLayouts[tableId];
		},
	};
}

describe('createSessionGridPersistence', () => {
	it('satisfies the shell DataGrid persistence contract', () => {
		const check = (p: IDataGridPersistence): IDataGridPersistence => p;
		assert.equal(typeof check(createSessionGridPersistence()).read, 'function');
	});

	it('reads report nothing until a layout is written; writes are read back', () => {
		const p = createSessionGridPersistence();
		assert.equal(p.read('t', 'sort'), false);
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'asc' }]);
		assert.equal(p.read('t', 'columns'), false, 'per type');
		assert.equal(p.read('other', 'sort'), false, 'per table');
	});

	it('hands out copies: Tabulator rewriting what it read in place never reaches the stored layout (the Rocket Builder freeze)', () => {
		const p = createSessionGridPersistence();
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		const handed = p.read('t', 'sort');
		tabulatorSetSort(handed);
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'asc' }], 'the stored blob is still plain JSON');
		const blob = [{ column: 'name', dir: 'desc' }];
		p.write('t', 'sort', blob);
		tabulatorSetSort(blob);
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'desc' }], 'what was written was copied, too');
	});

	it('a blob that is not plain JSON is not stored (the previous one stays), and never throws', () => {
		const p = createSessionGridPersistence();
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		assert.doesNotThrow(() => p.write('t', 'sort', [cyclic]));
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'asc' }]);
		assert.doesNotThrow(() => p.write('t', 'format', { fn: () => 1 }));
		assert.deepEqual(p.read('t', 'format'), {}, 'a function is dropped, as JSON drops it');
	});

	it('clear forgets one table', () => {
		const p = createSessionGridPersistence();
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		p.write('u', 'sort', [{ column: 'id', dir: 'asc' }]);
		p.clear('t');
		assert.equal(p.read('t', 'sort'), false);
		assert.deepEqual(p.read('u', 'sort'), [{ column: 'id', dir: 'asc' }]);
	});
});

describe('createCopyingGridPersistence (a full app over the shell\'s channel)', () => {
	it('hands out copies of what the host stores: Tabulator rewriting them never reaches the host\'s prefs (the full-app freeze)', () => {
		const prefs: IHostPrefs = { tableLayouts: { t: { sort: [{ column: 'name', dir: 'asc' }] } } };
		const p = createCopyingGridPersistence(() => hostChannel(prefs));
		const handed = p.read('t', 'sort');
		assert.deepEqual(handed, [{ column: 'name', dir: 'asc' }]);
		tabulatorSetSort(handed);
		assert.deepEqual(prefs.tableLayouts.t!.sort, [{ column: 'name', dir: 'asc' }], 'the host still holds plain JSON');
		assert.doesNotThrow(() => JSON.stringify(prefs), 'so the next workspace save can serialize it');
	});

	it('writes reach the host as plain copies, so a later in-place rewrite of the written blob cannot reach it either', () => {
		const prefs: IHostPrefs = { tableLayouts: {} };
		const p = createCopyingGridPersistence(() => hostChannel(prefs));
		const blob = [{ column: 'name', dir: 'desc' }];
		p.write('t', 'sort', blob);
		tabulatorSetSort(blob);
		assert.deepEqual(prefs.tableLayouts.t!.sort, [{ column: 'name', dir: 'desc' }]);
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'desc' }], 'and it reads back');
	});

	it('a blob that is not plain JSON never reaches the host, and nothing throws', () => {
		const prefs: IHostPrefs = { tableLayouts: { t: { sort: [{ column: 'name', dir: 'asc' }] } } };
		const p = createCopyingGridPersistence(() => hostChannel(prefs));
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		assert.doesNotThrow(() => p.write('t', 'sort', [cyclic]));
		assert.deepEqual(prefs.tableLayouts.t!.sort, [{ column: 'name', dir: 'asc' }], 'the previous layout stays');
		assert.doesNotThrow(() => JSON.stringify(prefs));
	});

	it('makes its inner persistence on first use, once, never at creation (an env is built where no shell runs)', () => {
		const prefs: IHostPrefs = { tableLayouts: { t: { sort: [{ column: 'name', dir: 'asc' }] } } };
		let made = 0;
		const p = createCopyingGridPersistence(() => {
			made++;
			return hostChannel(prefs);
		});
		assert.equal(made, 0);
		p.read('t', 'sort');
		p.write('t', 'columns', []);
		p.clear('u');
		assert.equal(made, 1);
	});

	it('reads a stored blob that is not plain JSON as nothing, never as the object itself', () => {
		const cyclic: Record<string, unknown> = { column: 'name' };
		cyclic.self = cyclic;
		const prefs: IHostPrefs = { tableLayouts: { t: { sort: [cyclic] } } };
		const p = createCopyingGridPersistence(() => hostChannel(prefs));
		assert.equal(p.read('t', 'sort'), false);
	});

	it('reports nothing where the host has nothing, per table and type; clear reaches the host', () => {
		const prefs: IHostPrefs = { tableLayouts: { t: { sort: [{ column: 'name', dir: 'asc' }] } } };
		const p = createCopyingGridPersistence(() => hostChannel(prefs));
		assert.equal(p.read('t', 'columns'), false);
		assert.equal(p.read('u', 'sort'), false);
		p.clear('t');
		assert.equal('t' in prefs.tableLayouts, false);
		assert.equal(p.read('t', 'sort'), false);
	});
});
