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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEnvText, resolveConnectionEnv } from '../shared/util/envFile';

const URI = 'http://localhost:54321';
const KEY = 'MYAPIKEY';
const updates = { ROCKETRIDE_URI: URI, ROCKETRIDE_APIKEY: KEY };

/** Mimics the workspace .env parsing in packages/client-python/src/rocketride/client.py. */
function parseClientPythonEnv(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmedLine = line.trim();
		if (!trimmedLine || trimmedLine.startsWith('#') || !trimmedLine.includes('=')) {
			continue;
		}

		const separator = trimmedLine.indexOf('=');
		const key = trimmedLine.slice(0, separator).trim();
		let value = trimmedLine.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

// --- mergeEnvText ------------------------------------------------------------

test('creates a new file from scratch when none exists', () => {
	assert.equal(mergeEnvText('', updates), `ROCKETRIDE_URI=${URI}\nROCKETRIDE_APIKEY=${KEY}\n`);
});

test('returns text unchanged when there is nothing to write', () => {
	assert.equal(mergeEnvText('', {}), '');
	assert.equal(mergeEnvText('# just a comment\n', {}), '# just a comment\n');
});

test('updates an existing key in place, keeping its position', () => {
	const existing = 'ROCKETRIDE_URI=http://localhost:5565\nFOO=bar';
	assert.equal(mergeEnvText(existing, { ROCKETRIDE_URI: URI }), `ROCKETRIDE_URI=${URI}\nFOO=bar`);
});

test('preserves comments, blank lines, and unrelated user variables', () => {
	const existing = '# my env\n\nFOO=bar\n# trailing note';
	const result = mergeEnvText(existing, updates);
	assert.ok(result.includes('# my env'));
	assert.ok(result.includes('FOO=bar'));
	assert.ok(result.includes('# trailing note'));
	assert.ok(result.includes(`ROCKETRIDE_URI=${URI}`));
	assert.ok(result.includes(`ROCKETRIDE_APIKEY=${KEY}`));
});

test('appends new keys after a blank separator when file has content', () => {
	const existing = 'FOO=bar';
	assert.equal(mergeEnvText(existing, updates), `FOO=bar\n\nROCKETRIDE_URI=${URI}\nROCKETRIDE_APIKEY=${KEY}`);
});

test('quotes values containing whitespace, # or =', () => {
	assert.equal(mergeEnvText('', { A: 'has space' }), 'A="has space"\n');
	assert.equal(mergeEnvText('', { A: 'a#b' }), 'A="a#b"\n');
	assert.equal(mergeEnvText('', { A: 'a=b' }), 'A="a=b"\n');
	assert.equal(mergeEnvText('', { A: 'plain' }), 'A=plain\n');
});

test('is idempotent — merging the same updates twice is a no-op', () => {
	const once = mergeEnvText('# header\nFOO=bar\n', updates);
	const twice = mergeEnvText(once, updates);
	assert.equal(twice, once);
});

test('removes keys listed in keysToRemove', () => {
	const existing = 'FOO=bar\nOLD=gone\nROCKETRIDE_URI=old';
	assert.equal(mergeEnvText(existing, { ROCKETRIDE_URI: URI }, new Set(['OLD'])), `FOO=bar\nROCKETRIDE_URI=${URI}`);
});

test('writes raw internal quotes and backslashes when a value needs quoting', () => {
	assert.equal(mergeEnvText('', { ROCKETRIDE_APIKEY: 'has "quote" and \\slash' }), 'ROCKETRIDE_APIKEY="has "quote" and \\slash"\n');
});

test('round-trips values through the client.py parser', () => {
	for (const value of ['plain', 'has spaces', 'has an "inner quote"', '"fully wrapped"', "'fully wrapped'", 'ends with "']) {
		assert.equal(parseClientPythonEnv(mergeEnvText('', { VALUE: value })).VALUE, value);
	}
});

test('does not treat inherited property names as sync updates', () => {
	const existing = 'toString=x\n__proto__=y\nFOO=bar';
	assert.doesNotThrow(() => mergeEnvText(existing, { ROCKETRIDE_URI: URI }));
	assert.equal(mergeEnvText(existing, { ROCKETRIDE_URI: URI }), `toString=x\n__proto__=y\nFOO=bar\n\nROCKETRIDE_URI=${URI}`);
});

test('preserves CRLF line endings without mixing in LF-only lines', () => {
	const existing = '# my env\r\nFOO=bar\r\nROCKETRIDE_URI=http://localhost:5565\r\n';
	const result = mergeEnvText(existing, updates);
	assert.equal(result, `# my env\r\nFOO=bar\r\nROCKETRIDE_URI=${URI}\r\n\r\nROCKETRIDE_APIKEY=${KEY}`);
	assert.ok(!/[^\r]\n/.test(result), 'no bare LF line endings');
});

test('uses CRLF when generating from a whitespace-only CRLF file', () => {
	assert.equal(mergeEnvText(' \r\n\t\r\n', { ROCKETRIDE_URI: URI }), `ROCKETRIDE_URI=${URI}\r\n`);
});

// --- resolveConnectionEnv ----------------------------------------------------

for (const mode of ['local', 'docker', 'service', 'onprem'] as const) {
	test(`writes both vars for self-hosted mode: ${mode}`, () => {
		assert.deepEqual(resolveConnectionEnv({ group: 'development', mode, httpUrl: URI, apiKey: KEY }), { ROCKETRIDE_URI: URI, ROCKETRIDE_APIKEY: KEY });
	});
}

test('skips cloud mode (OAuth token is not an SDK key)', () => {
	assert.equal(resolveConnectionEnv({ group: 'development', mode: 'cloud', httpUrl: 'https://api.rocketride.ai', apiKey: 'oauth-token' }), null);
});

test('skips the deployment group so it never fights over .env', () => {
	assert.equal(resolveConnectionEnv({ group: 'deployment', mode: 'local', httpUrl: URI, apiKey: KEY }), null);
});

test('returns null when there is no resolvable URI', () => {
	assert.equal(resolveConnectionEnv({ group: 'development', mode: 'local', httpUrl: '', apiKey: KEY }), null);
});

test('returns null when URI or API key contains a newline', () => {
	assert.equal(resolveConnectionEnv({ group: 'development', mode: 'local', httpUrl: `${URI}\nnext`, apiKey: KEY }), null);
	assert.equal(resolveConnectionEnv({ group: 'development', mode: 'local', httpUrl: URI, apiKey: `${KEY}\rnext` }), null);
});

test('writes only the URI when no API key is available', () => {
	assert.deepEqual(resolveConnectionEnv({ group: 'development', mode: 'local', httpUrl: URI, apiKey: '' }), { ROCKETRIDE_URI: URI });
});
