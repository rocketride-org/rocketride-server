// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE FAILURE BANNER'S WORDS
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { failureView } from '../src/graph/failureView';
import type { IFailureViewInput } from '../src/graph/failureView';

const GENERIC = 'The node\'s message was not returned.';

const failed = (over: Partial<IFailureViewInput> = {}): IFailureViewInput => ({
	notice: { headline: 'Query failed', verbatim: 'Invalid input \'RETURNN\' (line 1, column 11 (offset: 10))', generic: false },
	index: 2,
	lines: 'line 3',
	prior: 'Statements 1–2 already ran.',
	...over,
});

test('a failed statement of a batch: where it was, what ran, what did not, and the database\'s text as it came', () => {
	const view = failureView(failed(), { total: 4, position: { line: 3, column: 11 }, genericText: GENERIC });
	assert.equal(view.headline, 'Query failed');
	assert.equal(view.where, 'Statement 3 failed (line 3, column 11).');
	assert.equal(view.prior, 'Statements 1–2 already ran.');
	assert.equal(view.notRun, 'Statement 4 was not run.');
	assert.equal(view.verbatim, 'Invalid input \'RETURNN\' (line 1, column 11 (offset: 10))');
	assert.equal(view.runFrom, 2);
	assert.equal(view.runFromLabel, 'Run from statement 3');
});

test('without a position the statement\'s line range is said, and without either, nothing', () => {
	assert.equal(failureView(failed({ lines: 'lines 4–6' }), { total: 4, genericText: GENERIC }).where, 'Statement 3 failed (lines 4–6).');
	assert.equal(failureView(failed({ lines: '' }), { total: 4, genericText: GENERIC }).where, 'Statement 3 failed.');
});

test('several statements were not run, and a failure of the last has none', () => {
	assert.equal(failureView(failed({ index: 1 }), { total: 4, genericText: GENERIC }).notRun, 'Statements 3–4 were not run.');
	assert.equal(failureView(failed({ index: 3 }), { total: 4, genericText: GENERIC }).notRun, '');
	assert.equal(failureView(failed({ index: 3 }), { genericText: GENERIC }).notRun, '', 'an unknown total says nothing about what was not run');
});

test('a single statement says "the statement", has no prior and offers no run-from', () => {
	const view = failureView(failed({ index: 0, prior: '', lines: 'line 1' }), { total: 1, position: { line: 1, column: 10 }, genericText: GENERIC });
	assert.equal(view.where, 'The statement failed (line 1, column 10).');
	assert.equal(view.prior, '');
	assert.equal(view.runFrom, null);
	assert.equal(view.runFromLabel, '');
});

test('when the node withheld its text the generic line replaces the headline and no database text is shown', () => {
	const view = failureView(failed({ notice: { headline: 'Query failed', verbatim: '', generic: true } }), { total: 2, genericText: GENERIC });
	assert.equal(view.headline, GENERIC);
	assert.equal(view.verbatim, '');
});

test('Copy error carries the headline, where it was and the database\'s text, nothing else', () => {
	const view = failureView(failed(), { total: 4, position: { line: 3, column: 11 }, genericText: GENERIC });
	assert.equal(view.copy, `Query failed\nStatement 3 failed (line 3, column 11).\nInvalid input 'RETURNN' (line 1, column 11 (offset: 10))`);
	assert.equal(failureView(failed({ notice: { headline: 'Refused: x', verbatim: '', generic: false } }), { total: 1, genericText: GENERIC }).copy, 'Refused: x\nThe statement failed (line 3).');
});

// -----------------------------------------------------------------------------
// The component: the text is in the DOM without a click
// -----------------------------------------------------------------------------

const banner = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'GraphFailureBanner.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');

test('the banner shows the database text as a block, with no toggle hiding it', () => {
	assert.match(banner, /<pre[^>]*>\{view\.verbatim\}<\/pre>/);
	assert.doesNotMatch(banner, /useState\(false\)[\s\S]{0,80}(show|open|expanded)/i, 'no expand state');
	assert.doesNotMatch(banner, /Database said|saidLabel/, 'the text is not put behind a label');
	assert.match(banner, /maxHeight/, 'six lines are visible and the rest scrolls');
	assert.match(banner, /Copy error/);
	assert.match(banner, /onRunFrom/);
});
