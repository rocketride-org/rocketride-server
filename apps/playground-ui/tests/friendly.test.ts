// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Friendly names, relative dates and conversation titles (core/friendly.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedWords, fileCount, friendlyName, nameFromAddress, relativeDate, titleFromFiles, titleFromQuestion, TITLE_MAX } from '../src/core/friendly';

test('friendlyName: snake_case, camelCase, dashes and spacing become words', () => {
	assert.equal(friendlyName('invoice_number'), 'Invoice number');
	assert.equal(friendlyName('dueDate'), 'Due date');
	assert.equal(friendlyName('row_count'), 'Row count');
	assert.equal(friendlyName('line-items'), 'Line items');
	assert.equal(friendlyName('Total'), 'Total');
	assert.equal(friendlyName('already spaced key'), 'Already spaced key');
});

test('friendlyName: acronyms keep their case; a key with no letters is unchanged', () => {
	assert.equal(friendlyName('invoice_URL'), 'Invoice URL');
	assert.equal(friendlyName('IBAN'), 'IBAN');
	assert.equal(friendlyName('___'), '___');
});

test('nameFromAddress: the pipeline id in title case, roots and sources ignored', () => {
	assert.equal(nameFromAddress('acme.invoiceReader'), 'Invoice Reader');
	assert.equal(nameFromAddress('acme.invoiceReader.dropper_1'), 'Invoice Reader');
	assert.equal(nameFromAddress('@public/acme.docBrain'), 'Doc Brain');
});

test('relativeDate: minutes, hours, yesterday, then a month-day', () => {
	const now = Date.UTC(2026, 10, 23, 12, 0, 0);
	assert.equal(relativeDate(now - 30_000, now), '1m ago');
	assert.equal(relativeDate(now - 12 * 60_000, now), '12m ago');
	assert.equal(relativeDate(now - 3 * 3_600_000, now), '3h ago');
	assert.equal(relativeDate(now - 30 * 3_600_000, now), 'yesterday');
	assert.match(relativeDate(now - 9 * 86_400_000, now), /\d/);
});

test('elapsedWords: seconds, then minutes and seconds', () => {
	assert.equal(elapsedWords(0, 3_000), '3 s');
	assert.equal(elapsedWords(0, 64_000), '1 m 4 s');
});

test('titles: a question is clipped to the Agent tool limit; files name the first and count the rest', () => {
	assert.equal(titleFromQuestion('  What is our   leave policy?  '), 'What is our leave policy?');
	const long = 'x'.repeat(TITLE_MAX + 20);
	assert.equal(titleFromQuestion(long).length, TITLE_MAX);
	assert.ok(titleFromQuestion(long).endsWith('…'));
	assert.equal(titleFromFiles(['globex-0142.pdf']), 'globex-0142.pdf');
	assert.equal(titleFromFiles(['globex-0142.pdf', 'a.pdf', 'b.pdf']), 'globex-0142.pdf and 2 more');
	assert.equal(fileCount(1), '1 file');
	assert.equal(fileCount(46), '46 files');
});
