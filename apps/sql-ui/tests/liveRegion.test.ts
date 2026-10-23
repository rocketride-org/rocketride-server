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
// ONE LIVE REGION PER REALM
// =============================================================================
//
// In-shell, every dev-tool frame (and the full app) shares one realm and one
// announcer. Each root mounts <LiveRegion />, but only the first alive one
// renders the region, so a sentence is spoken once, not once per document.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRegionClaims } from '../src/components/LiveRegion';

const SRC = path.resolve(__dirname, '..', 'src');

describe('the realm renders one live region, whatever the number of open documents', () => {
	it('the first alive mount renders it; the claim passes on when that mount goes', () => {
		const claims = createRegionClaims();
		let told = 0;
		const off = claims.subscribe(() => { told += 1; });
		const a = Symbol('a');
		const b = Symbol('b');
		const c = Symbol('c');
		assert.equal(claims.holder(), null);
		const releaseA = claims.claim(a);
		const releaseB = claims.claim(b);
		claims.claim(c);
		assert.equal(claims.holder(), a, 'one holder: three documents, one region');
		releaseA();
		assert.equal(claims.holder(), b);
		releaseA();
		assert.equal(claims.holder(), b, 'releasing twice changes nothing');
		releaseB();
		assert.equal(claims.holder(), c);
		assert.ok(told >= 5, 'mounts are told whenever the holder may change');
		off();
	});

	it('StrictMode\'s mount, unmount, mount keeps one claim per mount', () => {
		const claims = createRegionClaims();
		const a = Symbol('a');
		const b = Symbol('b');
		claims.claim(a)();
		claims.claim(a);
		claims.claim(a);
		const releaseB = claims.claim(b);
		assert.equal(claims.holder(), a);
		releaseB();
		assert.equal(claims.holder(), a);
	});

	it('every root mounts it once, and the region goes to document.body (a background tab is display: none)', () => {
		const devTool = fs.readFileSync(path.join(SRC, 'SqlDevTool.tsx'), 'utf8');
		assert.equal(devTool.match(/<LiveRegion \/>/g)?.length, 1, 'once per frame, at its root');
		const doc = devTool.slice(devTool.indexOf('const SqlConnectionDocument'), devTool.indexOf('export const SqlDevTool'));
		assert.doesNotMatch(doc, /<LiveRegion/);
		const app = fs.readFileSync(path.join(SRC, 'SqlApp.tsx'), 'utf8');
		assert.equal(app.match(/<LiveRegion \/>/g)?.length, 1);
		const region = fs.readFileSync(path.join(SRC, 'components', 'LiveRegion.tsx'), 'utf8');
		assert.match(region, /if \(holder !== id \|\| typeof document === 'undefined'\) return null;/);
		assert.match(region, /return createPortal\(<Region \/>, document\.body\);/);
	});
});
