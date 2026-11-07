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

import { WatchRegistry, pageOf } from '../providers/toolhost/watchRegistry';

/** A registry whose subscriptions record when they are disposed. */
function harness(): { registry: WatchRegistry; disposed: string[]; watch: (sub: string) => void } {
	const registry = new WatchRegistry();
	const disposed: string[] = [];
	const watch = (sub: string): void => registry.add(sub, () => [{ dispose: () => disposed.push(sub) }]);
	return { registry, disposed, watch };
}

test('pageOf: fs-abc-3 is page fs-abc', () => {
	assert.equal(pageOf('fs-abc-3'), 'fs-abc');
});

test('pageOf: a key with no dash is its own page', () => {
	assert.equal(pageOf('plain'), 'plain');
});

test("(a) new page's watch before view:ready: the new watcher survives, the old page's is dropped", () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1'); // the reloaded page's tool effect runs first
	registry.resetForPageBoot(); // then the page's view:ready arrives
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed, ['fs-old-1']);
});

test('(b) view:ready before any new watch: the old page survives one boot and retires on the next', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	registry.resetForPageBoot(); // the new page has not watched yet
	assert.deepEqual(registry.keys(), ['fs-old-1']);
	watch('fs-new-1');
	registry.resetForPageBoot(); // the next boot retires it
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed, ['fs-old-1']);
});

test("a page's later watches keep it the newest page", () => {
	const { registry, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1');
	watch('fs-new-2');
	registry.resetForPageBoot();
	assert.deepEqual(registry.keys(), ['fs-new-1', 'fs-new-2']);
});

test("an older page's later watch does not become the newest page", () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1');
	watch('fs-old-2'); // the old page adds a watcher after the new page appeared
	registry.resetForPageBoot();
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed, ['fs-old-1', 'fs-old-2']);
});

test('re-adding a key replaces it and disposes the previous subscription', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-p-1');
	watch('fs-p-1');
	assert.deepEqual(registry.keys(), ['fs-p-1']);
	assert.deepEqual(disposed, ['fs-p-1']);
});

test('(c) dispose drops every watcher', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1');
	watch('fs-new-2');
	registry.dispose();
	assert.deepEqual(registry.keys(), []);
	assert.deepEqual(disposed.sort(), ['fs-new-1', 'fs-new-2', 'fs-old-1']);
});
