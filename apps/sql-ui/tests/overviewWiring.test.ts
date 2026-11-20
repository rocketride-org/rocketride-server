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
// OVERVIEW WIRING — a row opens the data, the Details button opens the drawer
// =============================================================================
//
// One click on a table row opens its Data page. The drawer is opened by the
// Details button (or a sidebar tree click), and that button must NOT open the
// data. The drawer's data button reads "Open data" and it can copy the table
// name and a SELECT. The panel has no DOM harness here, so this reads the
// source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');

describe('OverviewPanel', () => {
	const overview = src('panels', 'OverviewPanel.tsx');

	it('opens the table data on a row click', () => {
		assert.match(overview, /pageNav\.openTableData\(row\.name\)/);
	});

	it('has a Details action that opens only the drawer', () => {
		const action = /key: 'details'[\s\S]*?onAction: \(_key, row\) => ([^,]*),/.exec(overview);
		assert.ok(action, 'details action not found');
		assert.equal(action[1], 'setStack([row.name])');
	});

	it('titles the grid with the schema the reflection covers', () => {
		assert.match(overview, /title="Tables in the connection's default schema"/);
	});
});

describe('TableRecordPanel', () => {
	const drawer = src('components', 'TableRecordPanel.tsx');

	it('says "Open data", not "Browse Data"', () => {
		assert.match(drawer, />Open data</);
		assert.ok(!/Browse Data/.test(drawer));
	});

	it('copies the table name and a SELECT', () => {
		assert.match(drawer, />Copy name</);
		assert.match(drawer, />Copy SELECT</);
	});

	it('marks foreign-key columns from the FK label helper', () => {
		assert.match(drawer, /fkLabelsByColumn\(def\)/);
		assert.match(drawer, /fkLabels\.get\(col\.column\)/);
	});
});

describe('the empty workbench', () => {
	it('explains how to add a database, in the app and in the dev tool', () => {
		for (const file of ['SqlApp.tsx', 'SqlDevTool.tsx']) {
			assert.match(src(file), /add a database with \+ New Connection: pick a database node from a pipeline you are running, or enter the connection details directly/, file);
		}
	});
});
