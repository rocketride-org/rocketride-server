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

test('view:ready before any new watch: the new page\'s first watch retires the old page', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	registry.resetForPageBoot(); // the old page's own view:ready
	registry.resetForPageBoot(); // the new page's view:ready, before it has watched
	assert.deepEqual(registry.keys(), ['fs-old-1'], 'nothing newer to keep yet');
	watch('fs-new-1'); // its first watch retires the old page at once
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

test('after the usual order, a later unseen page does not drop the live page', () => {
	const { registry, disposed, watch } = harness();
	watch('fs-old-1');
	watch('fs-new-1'); // the new page's watch first...
	registry.resetForPageBoot(); // ...then its view:ready: nothing left to retire
	watch('fs-other-1'); // an unseen prefix (e.g. a second realm) must not retire the live page
	assert.deepEqual(registry.keys(), ['fs-new-1', 'fs-other-1']);
	assert.deepEqual(disposed, ['fs-old-1']);
});

test('when both pages boot view:ready first, the new page still retires the old one', () => {
	const { registry, disposed, watch } = harness();
	registry.resetForPageBoot(); // the old page's view:ready...
	watch('fs-old-1'); // ...then its first watch completes that boot
	registry.resetForPageBoot(); // the new page's view:ready, before it has watched
	watch('fs-new-1');
	assert.deepEqual(registry.keys(), ['fs-new-1']);
	assert.deepEqual(disposed, ['fs-old-1']);
});

test('the first boot leaves nothing to drop', () => {
	const { registry, disposed, watch } = harness();
	registry.resetForPageBoot(); // view:ready before any watch at all
	watch('fs-first-1');
	assert.deepEqual(registry.keys(), ['fs-first-1']);
	assert.deepEqual(disposed, []);
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
