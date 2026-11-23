// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// KEY EXPIRY TESTS — the reveal shows the expiry the server granted
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { revealedKeyExpiry, utcDay } from './keyExpiry';

test('a "never expires" request capped by the server shows the granted date, marked as bounded', () => {
	assert.deepEqual(revealedKeyExpiry(undefined, '2027-02-03T10:00:00'), { expiresAt: '2027-02-03T10:00:00', bounded: true });
});

test('a longer request capped by the server is marked as bounded; a granted request is not', () => {
	assert.deepEqual(revealedKeyExpiry('2030-01-01T00:00:00.000Z', '2027-02-03T10:00:00'), { expiresAt: '2027-02-03T10:00:00', bounded: true });
	assert.deepEqual(revealedKeyExpiry('2027-01-01T10:00:00.000Z', '2027-01-01T10:00:00.250000'), { expiresAt: '2027-01-01T10:00:00.250000', bounded: false });
	assert.deepEqual(revealedKeyExpiry('2027-01-01T10:00:30.000Z', '2027-01-01T10:00:00'), { expiresAt: '2027-01-01T10:00:00', bounded: true });
	assert.deepEqual(revealedKeyExpiry('2027-01-01T10:00:00.400Z', '2027-01-01T10:00:00'), { expiresAt: '2027-01-01T10:00:00', bounded: false });
});

test('a key the server says does not expire shows no expiry', () => {
	assert.deepEqual(revealedKeyExpiry(undefined, null), { expiresAt: null, bounded: false });
});

test('a requested expiry the server grants as "does not expire" shows no expiry', () => {
	assert.deepEqual(revealedKeyExpiry('2027-01-01T00:00:00.000Z', null), { expiresAt: null, bounded: false });
});

test('an older server that does not report the expiry falls back to the requested value', () => {
	assert.deepEqual(revealedKeyExpiry(undefined, undefined), { expiresAt: null, bounded: false });
	assert.deepEqual(revealedKeyExpiry('2027-01-01T00:00:00.000Z', undefined), { expiresAt: '2027-01-01T00:00:00.000Z', bounded: false });
});

test('an expiry that is not a timestamp is treated as not reported and never throws (the key is already minted)', () => {
	for (const odd of [1798761600000, { when: 'soon' }, ['2027-01-01'], true, '', '  ']) {
		assert.deepEqual(revealedKeyExpiry(undefined, odd as never), { expiresAt: null, bounded: false });
		assert.deepEqual(revealedKeyExpiry('2027-01-01T00:00:00.000Z', odd as never), { expiresAt: '2027-01-01T00:00:00.000Z', bounded: false });
	}
});

test('the expiry day is the UTC day, not the viewer\'s local day', () => {
	assert.equal(utcDay('2027-02-03T02:00:00'), '2027-02-03');
	assert.equal(utcDay('2027-02-03T02:00:00Z'), '2027-02-03');
	assert.equal(utcDay('2027-02-03T23:30:00-05:00'), '2027-02-04');
	assert.equal(utcDay('not a date'), 'not a date');
});
