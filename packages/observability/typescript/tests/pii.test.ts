/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
 */

import { scrubPii, scrubPiiString } from '../src/pii';

describe('scrubPii', () => {
	describe('email scrubbing', () => {
		it('should redact email local part, keep domain', () => {
			const result = scrubPii({ event: 'user alice@example.com logged in' });
			expect(result.event).toBe('user ***@example.com logged in');
		});

		it('should handle email in a value field', () => {
			const result = scrubPii({ email: 'bob.smith@company.org' });
			expect(result.email).toBe('***@company.org');
		});

		it('should handle multiple emails', () => {
			const result = scrubPii({ msg: 'from alice@a.com to bob@b.com' });
			expect(result.msg).toContain('***@a.com');
			expect(result.msg).toContain('***@b.com');
			expect(result.msg).not.toContain('alice');
			expect(result.msg).not.toContain('bob');
		});
	});

	describe('token scrubbing', () => {
		it('should redact Bearer tokens', () => {
			const result = scrubPii({ auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' });
			expect(result.auth).not.toContain('eyJ');
			expect(result.auth).toContain('***REDACTED***');
			expect((result.auth as string).startsWith('Bearer ')).toBe(true);
		});

		it('should redact generic tokens', () => {
			const result = scrubPii({ event: 'token=abcdefghijklmnopqrstuvwx' });
			expect(result.event).not.toContain('abcdefghijklmnopqrstuvwx');
			expect(result.event).toContain('***REDACTED***');
		});
	});

	describe('AWS key scrubbing', () => {
		it('should redact AWS access key IDs', () => {
			const result = scrubPii({ key: 'AKIAIOSFODNN7EXAMPLE' });
			expect(result.key).not.toContain('AKIA');
			expect(result.key).toBe('***REDACTED***');
		});

		it('should redact AWS secret keys', () => {
			const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1';
			const result = scrubPii({ config: `aws_secret_access_key=${secret}` });
			expect(result.config).not.toContain(secret);
			expect(result.config).toContain('***REDACTED***');
		});
	});

	describe('path scrubbing', () => {
		it('should scrub macOS user paths', () => {
			const result = scrubPii({ path: '/Users/dmitrii/Documents/secret.txt' });
			expect(result.path).not.toContain('dmitrii');
			expect(result.path).toContain('/Users/***/');
		});

		it('should scrub Linux home paths', () => {
			const result = scrubPii({ path: '/home/worker/app/data.csv' });
			expect(result.path).not.toContain('worker');
			expect(result.path).toContain('/home/***/');
		});
	});

	describe('non-string values', () => {
		it('should preserve integers', () => {
			const result = scrubPii({ count: 42, event: 'test' });
			expect(result.count).toBe(42);
		});

		it('should preserve null', () => {
			const result = scrubPii({ value: null, event: 'test' });
			expect(result.value).toBeNull();
		});
	});
});

describe('scrubPiiString', () => {
	it('should scrub a single string value', () => {
		const result = scrubPiiString('user alice@example.com at /Users/alice/data');
		expect(result).toBe('user ***@example.com at /Users/***/data');
	});
});
