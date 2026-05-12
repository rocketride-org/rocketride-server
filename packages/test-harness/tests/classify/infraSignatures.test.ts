import { describe, expect, it } from 'vitest';

import { classifyError, INFRA_SIGNATURES } from '../../src/classify/infraSignatures';

describe('classifyError', () => {
	it('returns null for undefined or empty input', () => {
		expect(classifyError(undefined)).toBeNull();
		expect(classifyError('')).toBeNull();
	});

	it('returns null for a normal logic error', () => {
		expect(classifyError('TypeError: cannot read property foo of undefined')).toBeNull();
	});

	it('matches a literal substring case-insensitively', () => {
		const hit = classifyError('Anthropic API returned: Credit Balance Is Too Low');
		expect(hit).not.toBeNull();
		expect(hit?.signature).toBe('credit balance is too low');
	});

	it('matches the rate_limit_error literal', () => {
		const hit = classifyError('Error code: rate_limit_error');
		expect(hit?.signature).toBe('rate_limit_error');
	});

	it('matches a regex signature against 429 responses', () => {
		const hit = classifyError('HTTP 429 Too Many Requests received from upstream');
		expect(hit).not.toBeNull();
		// regex source from infraSignatures.ts; case-insensitive match
		expect(hit?.signature).toMatch(/429/);
	});

	it('matches network connection signatures', () => {
		expect(classifyError('connect ECONNREFUSED 127.0.0.1:5565')?.signature).toBe('ECONNREFUSED');
		expect(classifyError('Error: getaddrinfo ENOTFOUND api.example.com')?.signature).toBe('getaddrinfo ENOTFOUND');
		expect(classifyError('socket hang up while reading response')?.signature).toBe('socket hang up');
	});

	it('does not double-count when the message contains multiple signatures', () => {
		const hit = classifyError('upstream rate_limit_error and 429 Too Many Requests');
		expect(hit).not.toBeNull();
		// First match wins; both candidates are valid signatures
		expect(['rate_limit_error', '429\\s+Too Many Requests']).toContain(hit?.signature);
	});

	it('exposes the raw error in rawError for the report', () => {
		const raw = 'connect ETIMEDOUT 1.2.3.4:443';
		const hit = classifyError(raw);
		expect(hit?.rawError).toBe(raw);
	});

	it('keeps the signature list non-empty', () => {
		expect(INFRA_SIGNATURES.length).toBeGreaterThan(0);
	});
});
