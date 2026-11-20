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
// QUERY VIEW — statements run through the shared runner, in the document
// =============================================================================
//
// The batch's rules (one statement per call, stop at the first failure, drop
// a late answer after Stop waiting, ask before a flagged pattern) are the
// shared runner's, tested in shared/explorer/runner. What is pinned here is
// QueryView's wiring onto it: the runner runs in the DOCUMENT, and its session
// is whatever SqlEnv gives the document (the REMOTE proxy in a dev-tool frame,
// so every statement is an op on the controller). The view has no DOM
// harness, so this reads the source, as the other wiring suites do.
//
// Port of 4c584a214 (which added no tests: its rules run in the shared suites).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('QueryView on the shared runner', () => {
	const view = read('views/QueryView.tsx');

	it('runs batches with useStatementRunner, keeping SQL\'s own decisions as its hooks', () => {
		assert.match(view, /useStatementRunner<StatementRun, \{ sql: string \}, SqlExecuteResult, FailureNotice>\(\{/);
		assert.match(view, /refuse: \(list\) => \(list\.some\(\(run\) => run\.kind === 'tx'\) \? TRANSACTION_REFUSAL_TEXT : null\)/);
		assert.match(view, /prepare: \(run\) => \{\s*const prepared = applyRowLimit\(run\.sql, limit, dialect\);/);
		assert.match(view, /record: \(run\) => env\.history\.record\(endpoint, toHistoryEntry\(run\)\)/);
	});

	it('sends each statement on the session SqlEnv gives the document (the remote proxy in a frame), repeatable only for a read', () => {
		assert.match(view, /execute: \(run, send(?:, ticket)?\) => env\.getSession\(endpoint\)\.execute\(send\.sql, \{ idempotent: run\.kind === 'read'/);
		assert.match(view, /canRun: \(\) => env\.ready/);
	});

	it('keeps no run loop of its own', () => {
		for (const gone of [/runSeqRef/, /patternResolverRef/, /STOP_WAITING_AFTER_MS/, /const askPatternConfirm/, /setTxRefused/]) {
			assert.doesNotMatch(view, gone);
		}
	});

	it('shows failures and confirmations with the shared banner and dialog', () => {
		assert.match(view, /<FailureBanner\s+failure=\{failure\}/);
		assert.match(view, /<PatternConfirmDialog\s+kind=\{patternPrompt\.finding\.kind\}/);
	});

	it('binds the strip and the inspector to the shared components, and the wording to the shared format', () => {
		assert.match(read('components/StatementStrip.tsx'), /<SharedStatementStrip<StatementRun> runs=\{runs\} selected=\{selected\} onSelect=\{onSelect\} labelOf=\{formatRunLabel\} \/>/);
		assert.match(read('components/CellInspector.tsx'), /<RowInspector/);
		assert.match(read('sql/batch.ts'), /export interface StatementRun extends IStatementRunBase \{/);
		assert.match(read('sql/batch.ts'), /from 'shared\/explorer\/runner\/format';/);
	});
});
