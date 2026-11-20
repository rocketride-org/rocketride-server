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
// EXPLORER — REACT BINDINGS WIRING (the history bridge names its owner)
// =============================================================================
//
// The history store forgets what it holds in memory when an attach names a
// different owner (history/owner.test.tsx). That only protects the next account
// if the bridge every Explorer mounts actually names one: the signed-in
// identity's fingerprint, re-attaching when it changes, before the new render
// is painted. There is no DOM harness here (react.tsx imports the shell), so
// this checks the source, as the apps' wiring suites do.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Line endings normalised: a Windows checkout is CRLF (.gitattributes `* text=auto`), and the patterns below match LF.
const source = fs.readFileSync(path.resolve(__dirname, 'react.tsx'), 'utf8').replace(/\r\n/g, '\n');

/**
 * The body of createHistoryPrefsBridge.
 *
 * @returns Its source text.
 */
function bridgeBody(): string {
	const match = /export function createHistoryPrefsBridge\([\s\S]*?\n\}\n/.exec(source);
	assert.ok(match, 'createHistoryPrefsBridge not found');
	return match[0];
}

describe('createHistoryPrefsBridge — the owner of the workspace it attaches', () => {
	it('reads the signed-in identity from the shell and reduces it to the fingerprint', () => {
		assert.match(source, /import \{[^}]*\buseAuthUser\b[^}]*\} from 'shell';/);
		assert.match(bridgeBody(), /identityFingerprint\(identityFromConnectResult\(useAuthUser\(\)\)\)/);
	});

	it('attaches under that owner and attaches again when it changes, before the render is painted', () => {
		const body = bridgeBody();
		assert.match(body, /useLayoutEffect\(\(\) => store\.attachPrefs\(stable, owner\), \[stable, owner\]\)/);
		assert.doesNotMatch(body, /useEffect\(\(\) => store\.attachPrefs/);
	});
});
