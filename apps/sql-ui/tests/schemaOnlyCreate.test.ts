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
// SCHEMA ONLY: CREATE TABLE — the Overview's create button takes the gate too
// =============================================================================
//
// On a node with allow_execute off, every statement path is off with a stated
// reason. The live run found "+ Create Table" on the Overview still enabled:
// it opened a designer whose Apply could never run. It is now a GatedButton
// with the same reason, described by the workbench's visible schema-only note.
// Design in the table drawer stays enabled on purpose (reading a table's
// structure and DDL is useful), and the designer says on open, above
// everything else, that Apply is off. The views have no DOM harness here, so
// the wiring is checked in the source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_ONLY_NOTE_ID } from '../src/executeGate';

const src = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');
const overview = src('panels', 'OverviewPanel.tsx');
const workbench = src('views', 'ConnectionView.tsx');
const designer = src('views', 'TableDesignView.tsx');
const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

describe('+ Create Table on a schema-only node', () => {
	it('is a GatedButton with the schema-only reason, pointing at the visible note', () => {
		const at = overview.indexOf('+ Create Table');
		assert.ok(at > 0);
		const open = overview.lastIndexOf('<GatedButton', at);
		assert.ok(open > 0 && !overview.slice(open, at).includes('</'), 'the nearest button is a GatedButton');
		const tag = overview.slice(open, at);
		assert.match(tag, /gateReason=\{gateReason\}/);
		assert.match(tag, /reasonId=\{SCHEMA_ONLY_NOTE_ID\}/);
	});

	it('the workbench note carries that id, named once', () => {
		assert.equal(SCHEMA_ONLY_NOTE_ID, 'sql-schema-only');
		assert.match(workbench, /<div id=\{SCHEMA_ONLY_NOTE_ID\} style=\{styles\.schemaOnlyNote\}>/);
		assert.match(workbench, /reasonId=\{SCHEMA_ONLY_NOTE_ID\}/);
		assert.doesNotMatch(workbench, /const SCHEMA_ONLY_ID = /);
	});
});

describe('Design on a schema-only node', () => {
	it('opens, and says first thing on the page that Apply is off', () => {
		assert.match(designer, /<div style=\{styles\.body\}>\s*\{applyGate !== null && \(\s*<div id=\{applyGateId\} style=\{styles\.cardGap\}>\{`Schema only: \$\{applyGate\} Changes stay staged; Apply is off\.`\}<\/div>/);
	});

	it('the README says Create Table is off and Design still opens', () => {
		assert.match(readme, /\*\*Open data\*\*, \*\*\+ Create Table\*\* and History's \*\*Rerun\*\* are off with the reason shown/);
		assert.match(readme, /\*\*Design\*\* still opens, to read a table's structure and its DDL, and says that Apply is off\./);
	});
});
