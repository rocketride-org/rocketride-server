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
import { resolveCreateKey, revealedKeyExpiry } from './keyExpiry';

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

test('an older server that does not report the expiry falls back to the requested value', () => {
	assert.deepEqual(revealedKeyExpiry(undefined, undefined), { expiresAt: null, bounded: false });
	assert.deepEqual(revealedKeyExpiry('2027-01-01T00:00:00.000Z', undefined), { expiresAt: '2027-01-01T00:00:00.000Z', bounded: false });
});

test('a legacy key-only host callback that returns a numeric expiresAt is narrowed to the key', async () => {
	const legacy = async () => ({ key: 'k1', expiresAt: 1893456000 });
	const create = resolveCreateKey(undefined, legacy);
	assert.deepEqual(await create({ name: 'n', permissions: [] }), { key: 'k1' });
});

test('an expiry-aware host callback is used as-is, for a timestamp, null or omitted expiry', async () => {
	const legacy = async () => ({ key: 'legacy' });
	for (const expiresAt of ['2027-02-03T10:00:00', null, undefined]) {
		const create = resolveCreateKey(async () => ({ key: 'k2', expiresAt }), legacy);
		assert.deepEqual(await create({ name: 'n', permissions: [] }), { key: 'k2', expiresAt });
	}
});
