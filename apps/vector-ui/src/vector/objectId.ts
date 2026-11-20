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
// VECTOR-UI — OBJECT IDS (the id the engine will give an upload)
// =============================================================================
//
// The app never sends an objectId with an upload. The engine derives one from
// the object's name when it opens the data pipe (rocketlib types.py):
//
//     url      = 'null://Stream/' + name
//     objectId = str(uuid.uuid5(uuid.NAMESPACE_URL, url))
//
// The drop zone derives the same id from the path it is about to send (the
// path is NFC-normalised before it is sent, so the derivation normalises too)
// and asks the store whether it already holds that document. Synchronous and
// pure (sha1.ts), so it works on every origin.
// =============================================================================

import { sha1, toHex, utf8Bytes } from './sha1';

/** RFC 4122 name-space id for URLs (Python's uuid.NAMESPACE_URL). */
export const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** What the engine puts before an upload's name to make its url. */
export const STREAM_URL_PREFIX = 'null://Stream/';

/**
 * The 16 bytes of a uuid string.
 *
 * @param uuid - 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.
 * @returns Its bytes.
 */
function uuidBytes(uuid: string): Uint8Array {
	if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) {
		throw new Error(`uuid5 needs a uuid as its namespace, got '${uuid}'`);
	}
	const hex = uuid.replace(/-/g, '');
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

/**
 * A name-based (version 5, SHA-1) uuid, as Python's `uuid.uuid5` computes it.
 *
 * @param namespace - The namespace uuid.
 * @param name - The name (hashed as UTF-8).
 * @returns The uuid, lowercase.
 */
export function uuid5(namespace: string, name: string): string {
	const ns = uuidBytes(namespace);
	const nameBytes = utf8Bytes(name);
	const input = new Uint8Array(ns.length + nameBytes.length);
	input.set(ns);
	input.set(nameBytes, ns.length);
	const bytes = sha1(input).slice(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
	const hex = toHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The objectId the engine gives an upload named `path` (no objectId sent).
 *
 * @param path - The name the upload carries (`objinfo.name`).
 * @returns The objectId.
 */
export function objectIdForPath(path: string): string {
	return uuid5(NAMESPACE_URL, STREAM_URL_PREFIX + path.normalize('NFC'));
}
