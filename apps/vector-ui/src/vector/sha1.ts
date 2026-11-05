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
// VECTOR-UI — SHA-1 (pure JavaScript, synchronous)
// =============================================================================
//
// Used for one thing: deriving the objectId the engine will give an uploaded
// file (uuid5, see objectId.ts), so the drop zone can ask the store whether a
// file with the same path is already stored before sending it.
//
// Why not the browser's digest API: it exists only on secure origins, and the
// console is also opened from plain-HTTP LAN addresses, where the collision
// check must still work. It is also asynchronous, and this is not.
//
// SHA-1 is used here as the uuid5 standard requires, not for security. FIPS
// 180-4 / RFC 3174; verified against the RFC's test vectors (tests/sha1.test.ts).
// No platform imports, no module state.
// =============================================================================

/**
 * Encode a string as UTF-8, exactly as `TextEncoder` does (a lone surrogate
 * becomes U+FFFD). Written out so the hash does not depend on a global.
 *
 * @param text - The string.
 * @returns Its UTF-8 bytes.
 */
export function utf8Bytes(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			// High surrogate: combine with a following low surrogate, else replace.
			const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
				i++;
			} else {
				code = 0xfffd;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			// A low surrogate with no high surrogate before it.
			code = 0xfffd;
		}
		if (code < 0x80) {
			out.push(code);
		} else if (code < 0x800) {
			out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		} else {
			out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		}
	}
	return Uint8Array.from(out);
}

/**
 * Rotate a 32-bit word left.
 *
 * @param value - The word.
 * @param bits - How far.
 * @returns The rotated word (unsigned).
 */
function rotl(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/**
 * SHA-1 of some bytes.
 *
 * @param message - The input.
 * @returns The 20-byte digest.
 */
export function sha1(message: Uint8Array): Uint8Array {
	// Padding: 0x80, zeros up to 56 mod 64, then the bit length as 64-bit big-endian.
	const length = message.length;
	const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
	padded.set(message);
	padded[length] = 0x80;
	const bitsHigh = Math.floor(length / 0x20000000); // (length * 8) / 2^32 without overflow
	const bitsLow = (length << 3) >>> 0;
	const end = padded.length;
	padded[end - 8] = (bitsHigh >>> 24) & 0xff;
	padded[end - 7] = (bitsHigh >>> 16) & 0xff;
	padded[end - 6] = (bitsHigh >>> 8) & 0xff;
	padded[end - 5] = bitsHigh & 0xff;
	padded[end - 4] = (bitsLow >>> 24) & 0xff;
	padded[end - 3] = (bitsLow >>> 16) & 0xff;
	padded[end - 2] = (bitsLow >>> 8) & 0xff;
	padded[end - 1] = bitsLow & 0xff;

	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;
	const w = new Uint32Array(80);

	for (let block = 0; block < end; block += 64) {
		for (let t = 0; t < 16; t++) {
			const at = block + t * 4;
			w[t] = ((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]) >>> 0;
		}
		for (let t = 16; t < 80; t++) {
			w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let t = 0; t < 80; t++) {
			let f: number;
			let k: number;
			if (t < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (t < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (t < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[t]) >>> 0;
			e = d;
			d = c;
			c = rotl(b, 30);
			b = a;
			a = temp;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}

	const digest = new Uint8Array(20);
	[h0, h1, h2, h3, h4].forEach((word, index) => {
		digest[index * 4] = (word >>> 24) & 0xff;
		digest[index * 4 + 1] = (word >>> 16) & 0xff;
		digest[index * 4 + 2] = (word >>> 8) & 0xff;
		digest[index * 4 + 3] = word & 0xff;
	});
	return digest;
}

/**
 * Lowercase hex of some bytes.
 *
 * @param bytes - The bytes.
 * @returns Two hex digits per byte.
 */
export function toHex(bytes: Uint8Array): string {
	let hex = '';
	for (let i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
	return hex;
}

/**
 * SHA-1 as lowercase hex. A string is hashed as its UTF-8 bytes.
 *
 * @param input - A string or bytes.
 * @returns The 40-character digest.
 */
export function sha1Hex(input: string | Uint8Array): string {
	return toHex(sha1(typeof input === 'string' ? utf8Bytes(input) : input));
}
