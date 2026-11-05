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
// DATA BROWSER WIRING — what the view hands the grid, the drawer and the planner
// =============================================================================
//
// The view has no DOM harness here, so this checks the source, as
// queryViewWiring.test.ts does. The pure parts (statements, the count planner,
// the drawer's model) have their own tests; this pins how the view uses them.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read one source file of the app.
 *
 * @param parts - Path segments under `src`.
 * @returns The file's text.
 */
function read(...parts: string[]): string {
	return fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');
}

const view = read('views', 'TableDataView.tsx');
const drawer = read('components', 'RecordDrawer.tsx');
const record = read('sql', 'record.ts');

describe('TableDataView wiring', () => {
	it('opens the record drawer on a row click', () => {
		assert.match(view, /onRowClick=\{handleRowClick\}/);
		assert.match(view, /<RecordDrawer/);
	});

	it('hands the grid copies of the rows, never the rows it keeps', () => {
		// Tabulator writes an undefined key into each row object per rendered column.
		assert.match(view, /pageResult\.rows\.map\(\(r\) => \(\{ \.\.\.r \}\)\)/);
		assert.match(view, /over\.rows\.map\(\(r\) => \(\{ \.\.\.r \}\)\)/);
	});

	it('plans the total before sending any count or estimate, and sends nothing for "none"', () => {
		assert.match(view, /planCount\(countRef\.current, countReq\)/);
		assert.match(view, /if \(plan === 'none'\) return empty;/);
		// The exact COUNT only runs when the plan says so.
		assert.match(view, /plan === 'count' \? exec\(stmts\.count, stmts\.params\)/);
		assert.match(view, /executeAllowed: sendAllowed,/);
	});

	it('does not cache a probe that was only superseded, and keeps "Count exactly" until a count lands', () => {
		assert.match(view, /superseded: !ticket\.isCurrent\(\)/);
		assert.match(view, /applyProbeResult\(/);
		assert.match(view, /if \(!settled\) throw/);
		// The flag is read without clearing it, and cleared where the exact total lands.
		assert.match(view, /const forceExact = forceExactRef\.current;\n/);
		assert.match(view, /forceExactRef\.current = false;\n\t\t\t\tcountRef\.current = applyTotalIfCurrent\(countRef\.current, epoch, key, total, true\)/);
	});

	it('forgets cached totals when the countEpoch prop changes', () => {
		assert.match(view, /countEpoch\?: number/);
		assert.match(view, /invalidateTotals\(countRef\.current\)/);
		assert.match(view, /\}, \[countEpoch\]\);/);
	});

	it('asks the grid for page 1 again when a chip changes', () => {
		assert.match(view, /gridRef\.current\?\.refetch\(\{ resetPage: true \}\)/);
		assert.match(view, /\}, \[chips\]\);/);
	});

	it('feeds the chips into every page statement', () => {
		const calls = view.match(/buildPageStatements\([^)]*\)/g) ?? [];
		assert.ok(calls.length >= 2);
		for (const call of calls) assert.match(call, /chips: chipsRef\.current/);
	});

	it('marks foreign-key columns in the header descriptions', () => {
		assert.match(view, /fkMarker\(graph, table, col\.column\)/);
	});

	it('does not call the page-navigation hook (the standalone routes render this view)', () => {
		assert.ok(!/useSqlPageNav/.test(view));
		assert.ok(!/useSqlPageNav/.test(drawer));
	});

	it('mirrors the sort chips onto the grid sorters', () => {
		assert.match(view, /grid\.clearSort\(\)/);
		assert.match(view, /grid\.setSort\(/);
	});
});

describe('Data page wiring in ConnectionView', () => {
	const connection = read('views', 'ConnectionView.tsx');
	const nav = read('pageNav.tsx');

	it('carries preset chips in the data seed and hands them to the page', () => {
		assert.match(nav, /openTableData\(table: string, chips\?: FilterChip\[\]\): void;/);
		// The seed carries the chips; openTableData asks first while edits are staged (P4 R2-M2), then seeds.
		assert.match(connection, /const openData = useCallback\(\(table: string, chips: FilterChip\[\]\) => \{\s*setDataSeed\(\{ table, chips, seq: \+\+seedSeqRef\.current \}\);/);
		assert.match(connection, /openTableData: \(table: string, chips\?: FilterChip\[\]\) => \{[\s\S]*?openData\(table, chips \?\? \[\]\);/);
		assert.match(connection, /<TableDataView key=\{dataSeed\.seq\} endpoint=\{endpoint\} table=\{dataSeed\.table\} presetFilters=\{dataSeed\.chips\} countEpoch=\{writeEpoch\} onOpenTable=\{pageNav\.openTableData\} \/>/);
	});

	it('stops statements once the node is known to be schema only, from the one execute state', () => {
		// The view reads the same per-connection state the framing does, so there is
		// one schema-only message and one source for "may I send".
		assert.match(view, /const sendAllowed = executeAllowed && executeState !== 'off';/);
		assert.match(view, /executeAllowed: sendAllowed, forceExact/);
		assert.match(view, /lookup=\{env\.ready && sendAllowed \? lookup : null\}/);
	});
});

describe('RecordDrawer', () => {
	// Live bug 3: the shell's footer row is right-aligned and does not wrap,
	// so Prev, Next, Edit, Delete, Copy row as JSON and Close (about 510 px)
	// spilled out of the 460 px drawer on the left. One wrapping container
	// takes the row instead.
	it('wraps its footer verbs inside the drawer rather than past its edge (live bug 3)', () => {
		assert.match(drawer, /footer=\{\s*<div style=\{styles\.footer\}>\s*\{nav\}/);
		assert.match(drawer, /footer: \{[\s\S]*?flex: '1 1 auto',[\s\S]*?minWidth: 0,[\s\S]*?flexWrap: 'wrap',[\s\S]*?justifyContent: 'flex-end',/);
	});

	it('never derives its fields from the keys of a row the grid has seen', () => {
		assert.ok(!/Object\.(keys|entries)\(/.test(drawer), 'the drawer lists a row\'s own keys');
		// The one place that lists a row's keys is the fallback for a table the
		// schema lacks, and it takes a row fresh from a lookup.
		const body = /export function recordFields\([\s\S]*?\n\}/.exec(record);
		assert.ok(body && !/Object\.(keys|entries)\(/.test(body[0]));
		assert.match(drawer, /tables\[edge\.refTable\] \?\? fallbackDef\(first\)/);
	});

	it('runs the foreign-key lookup through the statement the model builds', () => {
		assert.match(drawer, /referencedRowStatement\(dialect, edge, row, tables\)/);
		assert.match(drawer, /lookup\(stmt\.sql, stmt\.params\)/);
	});

	it('says so when the lookup finds no row', () => {
		assert.match(drawer, /No row in \$\{edge\.refTable\} where/);
	});

	it('shows a key too large to look up exactly as a disabled link with the reason, and Show rows off with it (DA-R1 I3)', () => {
		assert.match(drawer, /const linkOff = link \? linkRefusal\(link, row, tables\) : null;/);
		assert.match(drawer, /aria-disabled="true"/);
		assert.match(drawer, /aria-describedby=\{reasonId\(field\.column\)\}/);
		assert.match(drawer, /<div id=\{reasonId\(field\.column\)\} style=\{styles\.type\}>\{linkOff\}<\/div>/);
		assert.match(drawer, /const showOff = showRowsRefusal\(edge, row, tables\);/);
		assert.match(drawer, /const chips = childRowsPreset\(edge, row, tables\);/);
		assert.match(drawer, /<GatedButton[\s\S]*?gateReason=\{showOff\}[\s\S]*?Show rows/);
	});
});
