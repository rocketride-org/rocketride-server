/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
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

/** PII scrubbing utility for structured logging. */

const REDACTED = '***REDACTED***';

// Email: redact local part, keep domain (atomic-safe character classes to avoid ReDoS)
const EMAIL_RE = /[a-zA-Z0-9]+(?:[._%+\-][a-zA-Z0-9]+)*@([a-zA-Z0-9]+(?:[.\-][a-zA-Z0-9]+)*\.[a-zA-Z]{2,})/g;

// Bearer / OAuth tokens
const BEARER_RE = /(Bearer\s+)\S+/gi;

// Generic long token-like strings (hex/base64, 20+ chars)
const TOKEN_RE = /(token[=:\s]+)[A-Za-z0-9_\-/+]{20,}/gi;

// AWS access key IDs (AKIA...)
const AWS_KEY_RE = /AKIA[0-9A-Z]{16}/g;

// AWS secret keys (40-char base64 following common prefixes)
const AWS_SECRET_RE = /(aws_secret_access_key[=:\s]+)[A-Za-z0-9/+=]{40}/gi;

// File paths with /Users/<username>/ or /home/<username>/
const PATH_USERS_RE = /\/Users\/[^/\s]+\//g;
const PATH_HOME_RE = /\/home\/[^/\s]+\//g;

function scrubValue(value: string): string {
	value = value.replace(EMAIL_RE, '***@$1');
	value = value.replace(BEARER_RE, `$1${REDACTED}`);
	value = value.replace(TOKEN_RE, `$1${REDACTED}`);
	value = value.replace(AWS_KEY_RE, REDACTED);
	value = value.replace(AWS_SECRET_RE, `$1${REDACTED}`);
	value = value.replace(PATH_USERS_RE, '/Users/***/');
	value = value.replace(PATH_HOME_RE, '/home/***/');
	return value;
}

/**
 * Scrub PII from a record of log fields.
 *
 * Scans all string values and applies regex-based redaction for emails,
 * tokens, AWS keys, and user paths.
 */
export function scrubPii(data: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		result[key] = typeof value === 'string' ? scrubValue(value) : value;
	}
	return result;
}

/**
 * Scrub PII from a single string value.
 */
export function scrubPiiString(value: string): string {
	return scrubValue(value);
}
