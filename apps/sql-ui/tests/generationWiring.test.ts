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
// GENERATION WIRING — every read the app abandons carries a ticket down
// =============================================================================
//
// The session drops an abandoned call's one retry only when it is handed the
// caller's generation ticket (tests/session.test.ts). The views that send
// idempotent reads must therefore pass one: the query runner's batch ticket,
// and a per-request ticket in the plan drawer and the data browser that
// expires when a newer request replaces it or the view goes away. There is no
// DOM harness here, so this checks the source, as the other wiring suites do.
// In a dev-tool frame the ticket never crosses to the controller: the
// frame's remote session checks it (devtool.generation.test.ts).
//
// Port of 740b69c6d (tests/generationWiring.test.ts).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read one source file of the app.
 *
 * @param parts - Path segments under src/.
 * @returns Its text.
 */
function read(...parts: string[]): string {
	return fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');
}

describe('generation tickets reach the session', () => {
	it('the query runner passes the batch ticket with every statement', () => {
		const source = read('views', 'QueryView.tsx');
		assert.match(source, /execute: \(run, send, ticket\) => env\.getSession\(endpoint\)\.execute\(send\.sql, \{ idempotent: run\.kind === 'read', generation: ticket \}\)/);
	});

	it('the plan drawer takes a ticket per EXPLAIN and expires it when the drawer closes or the statement changes', () => {
		const source = read('components', 'ExplainPanel.tsx');
		assert.match(source, /const ticket = generation\.next\(\);/);
		assert.match(source, /session\.execute\(explainSql, \{ idempotent: true, generation: ticket \}\)/);
		assert.match(source, /return \(\) => \{\s*signal\.cancelled = true;\s*generation\.invalidate\(\);\s*\};/);
	});

	it('the data browser takes a ticket per page request (a newer one expires it) and expires it on unmount', () => {
		const source = read('views', 'TableDataView.tsx');
		assert.match(source, /const ticket = generation\.next\(\);/);
		assert.match(source, /session\.execute\(select, \{ params, idempotent: true, generation: ticket \}\)/);
		assert.match(source, /session\.execute\(count, \{ params, idempotent: true, generation: ticket \}\)/);
		assert.match(source, /useEffect\(\(\) => \(\) => generation\.invalidate\(\), \[generation\]\);/);
	});

	it('no other idempotent execute is sent without a ticket', () => {
		for (const file of [['views', 'QueryView.tsx'], ['components', 'ExplainPanel.tsx'], ['views', 'TableDataView.tsx']]) {
			const source = read(...file);
			const calls = source.match(/\.execute\([^;]*idempotent[^;]*\)/g) ?? [];
			for (const call of calls) assert.match(call, /generation: ticket/, `${file.join('/')}: ${call}`);
		}
	});
});
