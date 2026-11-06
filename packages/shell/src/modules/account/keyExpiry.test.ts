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
import { revealedKeyExpiry } from './keyExpiry';

test('a "never expires" request capped by the server shows the granted date, marked as bounded', () => {
	assert.deepEqual(revealedKeyExpiry(undefined, '2027-02-03T10:00:00'), { expiresAt: '2027-02-03T10:00:00', bounded: true });
});

test('a longer request capped by the server is marked as bounded; a granted request is not', () => {
	assert.deepEqual(revealedKeyExpiry('2030-01-01T00:00:00.000Z', '2027-02-03T10:00:00'), { expiresAt: '2027-02-03T10:00:00', bounded: true });
	assert.deepEqual(revealedKeyExpiry('2027-01-01T10:00:00.000Z', '2027-01-01T10:00:00.250000'), { expiresAt: '2027-01-01T10:00:00.250000', bounded: false });
});

test('a key the server says does not expire shows no expiry', () => {
	assert.deepEqual(revealedKeyExpiry(undefined, null), { expiresAt: null, bounded: false });
});

test('an older server that does not report the expiry falls back to the requested value', () => {
	assert.deepEqual(revealedKeyExpiry(undefined, undefined), { expiresAt: null, bounded: false });
	assert.deepEqual(revealedKeyExpiry('2027-01-01T00:00:00.000Z', undefined), { expiresAt: '2027-01-01T00:00:00.000Z', bounded: false });
});
