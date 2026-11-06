/*
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * createKey reports the expiry the server GRANTED (record.expiresAt), which a
 * SaaS server caps for a key minted over a sign-in session; and the CLI's
 * login line prints it instead of claiming the key never expires.
 */

import { describe, it, expect } from '@jest/globals';
import { AccountApi } from '../src/client/account';
import { describeLoginKeyExpiry, utcDay } from '../src/cli/keyExpiry';

function apiReturning(body: Record<string, unknown>) {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const client = {
		call: async (command: string, args: Record<string, unknown>) => {
			calls.push([command, args]);
			return body;
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { api: new AccountApi(client as any), calls };
}

describe('AccountApi.createKey', () => {
	it('returns the expiry the server granted, which can be earlier than requested', async () => {
		const { api, calls } = apiReturning({ key: 'rr_x', record: { id: 'k1', expiresAt: '2027-02-03T10:00:00' } });
		const result = await api.createKey({ name: 'ci', permissions: [], expiresAt: '2030-01-01T00:00:00Z' });
		expect(result).toEqual({ key: 'rr_x', expiresAt: '2027-02-03T10:00:00' });
		expect(calls).toEqual([['rrext_account_keys', { subcommand: 'create', name: 'ci', permissions: [], expiresAt: '2030-01-01T00:00:00Z' }]]);
	});

	it('reports null when the server says the key does not expire', async () => {
		const { api } = apiReturning({ key: 'rr_x', record: { id: 'k1', expiresAt: null } });
		expect(await api.createKey({ name: 'ci', permissions: [] })).toEqual({ key: 'rr_x', expiresAt: null });
	});

	it('leaves expiresAt absent when the server did not report it (never read as "never expires")', async () => {
		const { api } = apiReturning({ key: 'rr_x' });
		const result = await api.createKey({ name: 'ci', permissions: [] });
		expect(result).toEqual({ key: 'rr_x' });
		expect('expiresAt' in result).toBe(false);
	});
});

describe('describeLoginKeyExpiry', () => {
	it('prints the granted day, bounded by the sign-in session', () => {
		expect(describeLoginKeyExpiry('2027-02-03T23:30:00.123456')).toBe(
			' It expires on 2027-02-03 (bounded by your sign-in session); run `rocketride login` again before then.'
		);
	});

	it('says the key does not expire only when the server said so, and says nothing when it did not report', () => {
		expect(describeLoginKeyExpiry(null)).toBe(' It does not expire.');
		expect(describeLoginKeyExpiry(undefined)).toBe('');
	});

	it('reads an offset-less server timestamp as UTC, and keeps an unreadable one as is', () => {
		expect(utcDay('2027-02-03T23:59:59')).toBe('2027-02-03');
		expect(utcDay('2027-02-04T01:00:00+05:30')).toBe('2027-02-03');
		expect(utcDay('not a date')).toBe('not a date');
	});
});
