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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// sha1 — the pure-JS SHA-1 behind the upload collision check
// =============================================================================
//
// The objectId the engine gives an upload is uuid5(NAMESPACE_URL, …), which is
// SHA-1. Browsers only offer SHA-1 through an API that exists on secure
// origins, and the console is also opened from plain-HTTP LAN addresses, so the
// app carries its own. These tests pin it to the RFC 3174 test vectors and
// cross-check block boundaries against Node's own implementation (tests only).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha1, sha1Hex, utf8Bytes } from '../src/vector/sha1';

/**
 * Node's SHA-1 of some bytes, as lowercase hex (the reference).
 *
 * @param bytes - The input.
 * @returns The digest.
 */
function nodeSha1(bytes: Uint8Array): string {
	return createHash('sha1').update(bytes).digest('hex');
}

test('sha1: the four RFC 3174 test vectors', () => {
	// RFC 3174 section 7.3: TEST1..TEST4 with their repeat counts.
	const vectors: Array<{ text: string; repeat: number; digest: string }> = [
		{ text: 'abc', repeat: 1, digest: 'a9993e364706816aba3e25717850c26c9cd0d89d' },
		{ text: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', repeat: 1, digest: '84983e441c3bd26ebaae4aa1f95129e5e54670f1' },
		{ text: 'a', repeat: 1_000_000, digest: '34aa973cd4c4daa4f61eeb2bdbad27316534016f' },
		{ text: '0123456701234567012345670123456701234567012345670123456701234567', repeat: 10, digest: 'dea356a2cddd90c7a7ecedc5ebb563934f460452' },
	];
	for (const { text, repeat, digest } of vectors) {
		assert.equal(sha1Hex(text.repeat(repeat)), digest, `${repeat} x ${JSON.stringify(text.slice(0, 12))}`);
	}
});

test('sha1: the empty input', () => {
	assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
	assert.equal(sha1Hex(new Uint8Array(0)), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
});

test('sha1: digests are 20 bytes and agree with the hex form', () => {
	const digest = sha1(utf8Bytes('abc'));
	assert.ok(digest instanceof Uint8Array);
	assert.equal(digest.length, 20);
	assert.equal(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''), sha1Hex('abc'));
});

test('sha1: every length around the 64-byte block boundaries matches the reference', () => {
	// Padding is where hand-written SHA-1 breaks: 55/56 bytes decide whether the
	// length fits in the last block, 63/64/65 straddle a block, 119/120 the second.
	let seed = 7;
	const next = (): number => {
		seed = (seed * 1103515245 + 12345) >>> 0;
		return seed >>> 24;
	};
	for (let length = 0; length <= 200; length++) {
		const bytes = new Uint8Array(length);
		for (let i = 0; i < length; i++) bytes[i] = next();
		assert.equal(sha1Hex(bytes), nodeSha1(bytes), `length ${length}`);
	}
});

test('sha1: strings are hashed as UTF-8', () => {
	for (const text of ['naïve résumé', '日本語/資料.pdf', '📄 notes.md', 'with space/and+plus&amp.txt']) {
		assert.equal(sha1Hex(text), nodeSha1(new TextEncoder().encode(text)), text);
	}
});

test('utf8Bytes: encodes like TextEncoder, including astral characters and lone surrogates', () => {
	const samples = ['', 'plain ascii', 'é', '€', '日本', '📄', 'a\u{10FFFF}b', 'lone \uD800 high', 'lone \uDC00 low', 'pair 📄 ok', 'end \uD83D'];
	for (const text of samples) {
		assert.deepEqual(Array.from(utf8Bytes(text)), Array.from(new TextEncoder().encode(text)), JSON.stringify(text));
	}
});
