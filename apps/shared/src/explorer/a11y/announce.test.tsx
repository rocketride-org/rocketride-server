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
// EXPLORER A11Y — announcer and live region
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAnnouncer } from './announce';
import { createLiveRegion } from './LiveRegion';

describe('createAnnouncer', () => {
	it('starts empty and bumps the revision on every call, repeats included', () => {
		const announcer = createAnnouncer();
		assert.deepEqual(announcer.get(), { text: '', revision: 0 });
		announcer.announce('Statement returned 3 rows');
		const first = announcer.get();
		announcer.announce('Statement returned 3 rows');
		const second = announcer.get();
		assert.equal(first.text, second.text);
		assert.equal(second.revision, first.revision + 1);
		// A new object per call, so a useSyncExternalStore snapshot only changes when it should.
		assert.notEqual(first, second);
		assert.equal(announcer.get(), second);
	});

	it('notifies subscribers and stops after unsubscribe', () => {
		const announcer = createAnnouncer();
		let calls = 0;
		const unsubscribe = announcer.subscribe(() => { calls += 1; });
		announcer.announce('a');
		announcer.announce('b');
		unsubscribe();
		announcer.announce('c');
		assert.equal(calls, 2);
	});

	it('keeps two announcers independent', () => {
		const sql = createAnnouncer();
		const graph = createAnnouncer();
		let graphCalls = 0;
		graph.subscribe(() => { graphCalls += 1; });
		sql.announce('sql only');
		assert.equal(graph.get().text, '');
		assert.equal(graphCalls, 0);
	});
});

describe('createLiveRegion', () => {
	it('renders one polite, atomic, visually hidden status region that stays in the accessibility tree', () => {
		const LiveRegion = createLiveRegion(createAnnouncer());
		const markup = renderToStaticMarkup(<LiveRegion />);
		assert.match(markup, /role="status"/);
		assert.match(markup, /aria-live="polite"/);
		assert.match(markup, /aria-atomic="true"/);
		// Clipped to a 1px box; display:none / visibility:hidden would silence it.
		assert.match(markup, /clip:rect\(0 0 0 0\)/);
		assert.doesNotMatch(markup, /display:none|visibility:hidden/);
	});

	it('is bound to its own announcer: each app creates its own component', () => {
		const a = createLiveRegion(createAnnouncer());
		const b = createLiveRegion(createAnnouncer());
		assert.notEqual(a, b);
	});
});
