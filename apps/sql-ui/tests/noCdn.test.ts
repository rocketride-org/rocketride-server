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
// NO CDN — the SQL editor's Monaco is bundled, and the README says so
// =============================================================================
//
// The editor loads Monaco through the shared bundled loader, which is a chunk
// of the app's own build. An air-gapped browser therefore gets a working
// editor, and the README must not claim otherwise. These checks read the
// sources, as the other wiring tests do, so a CDN loader or a stale limit
// cannot come back without a test failing.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (...parts: string[]): string => fs.readFileSync(path.resolve(root, ...parts), 'utf8');

describe('SQL editor: no CDN', () => {
	it('loads Monaco through the shared bundled loader', () => {
		const editor = read('src', 'components', 'SqlEditor.tsx');
		assert.match(editor, /shared\/components\/monaco/);
		assert.ok(!/cdn\.jsdelivr|unpkg\.com|cdnjs|@monaco-editor\/loader/.test(editor), 'the editor names a CDN');
	});

	it('has a shared loader that imports the bundled build', () => {
		const loader = read('..', 'shared', 'src', 'components', 'monaco', 'loader.ts');
		assert.match(loader, /import\('monaco-editor\/esm\/vs\/editor\/editor\.main\.js'\)/);
		assert.ok(!/https?:\/\//.test(loader.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')), 'the loader fetches from a URL');
	});

	it('does not tell the reader the editor needs a CDN', () => {
		const readme = read('README.md').replace(/\s+/g, ' ');
		assert.ok(!/\bCDN\b/.test(readme), 'the README still mentions a CDN');
	});
});
