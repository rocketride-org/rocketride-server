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

// =============================================================================
// APP PATHS — store paths an isolated app may name
// =============================================================================
//
// An app's store is `apps/<appKey>` (the key, not the id, so look-alike ids
// never share a directory). A path is accepted only when it is that root or
// lies under it after NFC normalisation, with no `.`/`..` or empty segment
// (raw or percent-encoded), no backslash and no control character.
// =============================================================================

const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/** Whether one path segment is safe (the last may be empty: a trailing slash). */
function segmentOk(seg: string, last: boolean): boolean {
	if (seg === '') return last;
	if (seg === '.' || seg === '..') return false;
	if (seg.includes('%')) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(seg);
		} catch {
			return false;
		}
		if (decoded === '.' || decoded === '..' || decoded.includes('/') || CONTROL_OR_BACKSLASH.test(decoded)) return false;
	}
	return true;
}

/**
 * The canonical (NFC) form of an app store path.
 *
 * @param path - The path as the app sent it.
 * @param appKey - The realm's app key.
 * @returns The canonical path, or null when it is not under `apps/<appKey>`.
 */
export function canonicalAppPath(path: string, appKey: string): string | null {
	if (typeof path !== 'string') return null;
	const nfc = path.normalize('NFC');
	if (CONTROL_OR_BACKSLASH.test(nfc)) return null;
	const root = `apps/${appKey}`;
	if (nfc === root) return nfc;
	if (!nfc.startsWith(`${root}/`)) return null;
	const segs = nfc.slice(root.length + 1).split('/');
	for (let i = 0; i < segs.length; i++) {
		if (!segmentOk(segs[i], i === segs.length - 1)) return null;
	}
	return nfc;
}
