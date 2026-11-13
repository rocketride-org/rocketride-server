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
	const watch = (sub: string): void => {
		registry.add(sub, () => {
			return [
				{
					dispose: () => {
						disposed.push(sub);
					},
				},
			];
		});
	};
	return { registry, disposed, watch };
}

test('pageOf: fs-abc-3 is page fs-abc', () => {
	assert.equal(pageOf('fs-abc-3'), 'fs-abc');
});

test('pageOf: a key with no dash is its own page', () => {
	assert.equal(pageOf('plain'), 'plain');
});

test("new page's watch before view:ready: the new watcher survives, the old page's is dropped", () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1'); // the reloaded page's tool effect runs first
	registry.resetForPageBoot(); // then the page's view:ready arrives
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed, ['fs-old-1']);
});


test('a page that watches again after all its watchers were removed is not a new boot', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1');
	registry.remove('fs-old-1'); // the old page has no live watchers left...
	watch('fs-old-2'); // ...and then watches again: still the older page
	registry.resetForPageBoot();
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed.sort(), ['fs-old-1', 'fs-old-2']);
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



test('the first boot leaves nothing to drop', () => {
	const { registry, disposed, watch } = harness();
	registry.resetForPageBoot(); // view:ready before any watch at all
	watch('fs-first-1');
	assert.deepEqual(registry.keys(), ['fs-first-1']);
	assert.deepEqual(disposed, []);
});

test('view:ready names its page before that page has watched: the old page is retired at once', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	registry.resetForPageBoot('fs-new'); // the new page's view:ready comes first
	assert.deepEqual(registry.keys(), []);
	assert.deepEqual(disposed, ['fs-old-1']);
	watch('fs-new-1');
	assert.deepEqual(registry.keys(), ['fs-new-1']);
});

test('view:ready names its page after that page has watched: its watcher survives', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1'); // the new page's tool watches first
	registry.resetForPageBoot('fs-new');
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed, ['fs-old-1']);
});

test('a page reloaded before its own view:ready is retired by the next page', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-a-1');
	registry.resetForPageBoot('fs-a');
	watch('fs-k-1'); // page K watches, then reloads before its view:ready
	registry.resetForPageBoot('fs-l'); // page L names itself
	watch('fs-l-1');
	assert.deepEqual(registry.keys(), ['fs-l-1']);
	assert.deepEqual(disposed.sort(), ['fs-a-1', 'fs-k-1']);
});

test('a later unseen page does not drop the live page', () => {
	const { registry, watch } = harness();
	watch('fs-new-1');
	registry.resetForPageBoot('fs-new');
	watch('fs-other-1'); // e.g. a second realm: only the next view:ready decides
	assert.deepEqual(registry.keys(), ['fs-new-1', 'fs-other-1']);
});

test('without a page id, view:ready keeps the newest page that has watched', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1');
	registry.resetForPageBoot();
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed, ['fs-old-1']);
});

test('dispose drops every watcher', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1');
	watch('fs-new-2');
	registry.dispose();
	assert.deepEqual(registry.keys(), []);
	assert.deepEqual(disposed.sort(), ['fs-new-1', 'fs-new-2', 'fs-old-1']);
});
