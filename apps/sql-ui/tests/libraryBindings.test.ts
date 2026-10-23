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
// LIBRARY BINDINGS — history, announcer, navigation and URI rules
// =============================================================================
//
// SQL Explorer's history store, run bus, trim, announcer, live region,
// active-connection store, table-record channel and document-URI rule are
// instances of the shared Explorer library's factories, bound to SQL's own
// keys and schemes, not module-level copies of that code. The source checks
// pin the binding (the modules have no component harness); the behaviour
// checks pin what the binding must keep: the connection editor's
// `connedit:` / `edit:` families, the active-connection reads the dev-tool
// frame wiring uses, and the dismissable connection-overlay slot.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectionEditorDocKey, connectionEditorIdFromUri, connectionEditorUri, endpointKeyFromAnyUri, isConnectionEditorUri, parseConnectionEditorDocKey } from '../src/docs';
import { getActiveConnection, requestConnectionOverlay, setActiveConnection, subscribeActiveConnection } from '../src/navigation';

/**
 * Read one source file of the app.
 *
 * @param rel - Path under src/.
 * @returns The file's text.
 */
function source(rel: string): string {
	return fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf8');
}

describe('library bindings: each module is an instance of the shared factory', () => {
	const bindings: [string, RegExp][] = [
		['history/historyStore.ts', /createHistoryStore<'sql'>\(\{/],
		['history/historyStore.ts', /createHistoryPrefsBridge\(store\)/],
		['history/runEvents.ts', /createRunEvents<'sql'>\(\)/],
		['history/trim.ts', /from 'shared\/explorer\/history\/trim'/],
		['history/types.ts', /from 'shared\/explorer\/history\/types'/],
		['a11y/announce.ts', /createAnnouncer\(\)/],
		['components/LiveRegion.tsx', /createLiveRegion\(sqlAnnouncer\)/],
		['navigation.ts', /createActiveKeyStore\(\)/],
		['navigation.ts', /createRequestChannel<\{ key: string; table: string \}>\(\)/],
		['docs.ts', /keyFromAnyUri\(uri, SCHEMES\)/],
		['docs.ts', /createCounter\(\)/],
	];
	for (const [file, pattern] of bindings) {
		it(`${file} binds ${pattern.source}`, () => {
			assert.match(source(file), pattern);
		});
	}

	it('keeps no module-level copy of the state the factories own', () => {
		assert.doesNotMatch(source('history/historyStore.ts'), /^let /m, 'historyStore keeps its own module state');
		assert.doesNotMatch(source('a11y/announce.ts'), /^let snapshot/m, 'announce keeps its own snapshot');
		assert.doesNotMatch(source('navigation.ts'), /^let (activeConnectionKey|tableRequest)/m, 'navigation keeps its own active key or table request');
		assert.doesNotMatch(source('docs.ts'), /^let (querySeq|designSeq)/m, 'docs keeps its own counters');
	});
});

describe('library bindings: what the binding keeps', () => {
	it('keeps the connection editor families out of the endpoint-URI rule', () => {
		assert.equal(endpointKeyFromAnyUri(connectionEditorUri('c1')), null);
		assert.equal(endpointKeyFromAnyUri(connectionEditorUri(null)), null);
		assert.equal(endpointKeyFromAnyUri(connectionEditorDocKey('c1')), null);
		assert.equal(isConnectionEditorUri(connectionEditorUri('c1')), true);
		assert.equal(connectionEditorIdFromUri(connectionEditorUri('c1')), 'c1');
		assert.equal(connectionEditorIdFromUri(connectionEditorUri(null)), null);
		assert.deepEqual(parseConnectionEditorDocKey(connectionEditorDocKey('c1')), { connId: 'c1' });
		assert.deepEqual(parseConnectionEditorDocKey(connectionEditorDocKey(null)), { connId: null });
		assert.equal(parseConnectionEditorDocKey('p:tools_1:db_1'), null);
	});

	it('serves the active connection to plain code: get follows set, subscribe fires per change', () => {
		const seen: (string | null)[] = [];
		const off = subscribeActiveConnection(() => seen.push(getActiveConnection()));
		try {
			setActiveConnection('k1');
			setActiveConnection('k1');
			setActiveConnection(null);
		} finally {
			off();
		}
		setActiveConnection('k2');
		assert.deepEqual(seen, ['k1', null]);
		assert.equal(getActiveConnection(), 'k2');
		setActiveConnection(null);
	});

	it('keeps the connection-overlay slot dismissable (request null closes it)', () => {
		assert.doesNotThrow(() => requestConnectionOverlay(null));
		assert.match(source('navigation.ts'), /export type ConnectionOverlayRequest =/);
		assert.match(source('navigation.ts'), /export function useConnectionOverlay\(\): ConnectionOverlayRequest \| null/);
	});
});
