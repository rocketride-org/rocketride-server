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

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TabControl } from './TabControl';
import type { ViewMenu } from '../../types/viewMenu';

/**
 * Server-renders `element`. TabControl measures its tabs in a layout
 * effect, and React 18 warns about that on every server render; the effect
 * never runs here and the tests read only the markup, so that one warning
 * is dropped. Anything else still reaches the console.
 */
function renderMarkup(element: ReactElement): string {
	const original = console.error;
	console.error = (...args: unknown[]): void => {
		if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return;
		original(...args);
	};
	try {
		return renderToStaticMarkup(element);
	} finally {
		console.error = original;
	}
}

/** Renders a strip over `menu` with the first entry active. */
function render(menu: ViewMenu): string {
	return renderMarkup(<TabControl menu={menu} activeId={menu.entries[0].id} onSelect={() => undefined} />);
}

/** The opening tag of each rendered tab, in order. */
function tabTags(markup: string): string[] {
	return markup.match(/<div[^>]*role="tab"[^>]*>/g) ?? [];
}

test('a described tab carries its trimmed description as the tooltip', () => {
	const markup = render({
		entries: [
			{ id: 'build', label: 'Build', description: '  Compile the project and run its checks. ' },
			{ id: 'ship', label: 'Ship', description: 'Publish a version to your audience.' },
		],
	});
	const tabs = tabTags(markup);
	assert.equal(tabs.length, 2);
	assert.match(tabs[0], /title="Compile the project and run its checks\."/);
	assert.match(tabs[1], /title="Publish a version to your audience\."/);
	// Tooltip only: the label is the accessible name, and no
	// aria-description duplicates the title for screen readers.
	assert.doesNotMatch(markup, /aria-description=/);
	// The label stays the visible text; the description is never painted
	// into the strip.
	assert.match(markup, />Build</);
	assert.doesNotMatch(markup, />\s*Compile the project/);
});

test('a tab without a description renders no tooltip', () => {
	const plain = render({
		entries: [
			{ id: 'build', label: 'Build' },
			{ id: 'ship', label: 'Ship', count: 3 },
		],
	});
	assert.doesNotMatch(plain, /title=/);
	// Empty and whitespace-only descriptions count as absent: byte-identical markup.
	for (const blank of ['', '   ']) {
		const markup = render({
			entries: [
				{ id: 'build', label: 'Build', description: blank },
				{ id: 'ship', label: 'Ship', count: 3, description: blank },
			],
		});
		assert.equal(markup, plain, `description ${JSON.stringify(blank)} rendered an attribute`);
	}
});

test('an icon tab keeps its label in the tooltip and adds the description after a colon', () => {
	const markup = renderMarkup(
		<TabControl
			iconsOnly
			menu={{
				entries: [
					{ id: 'logs', label: 'Logs', icon: <svg />, description: ' Read what the app printed. ' },
					{ id: 'events', label: 'Events', icon: <svg /> },
					{ id: 'notes', label: 'Notes', description: 'Keep notes on this run.' },
				],
			}}
			activeId="logs"
			onSelect={() => undefined}
		/>
	);
	const tabs = tabTags(markup);
	assert.equal(tabs.length, 3);
	// The icon tab shows no text, so its tooltip leads with the label; the
	// label stays the accessible name.
	assert.match(tabs[0], /title="Logs: Read what the app printed\."/);
	assert.match(tabs[0], /aria-label="Logs"/);
	// An icon tab without a description keeps the label-only tooltip.
	assert.match(tabs[1], /title="Events"/);
	// No icon: the label is painted as text, so the tooltip is the
	// description alone, as on a text tab.
	assert.match(tabs[2], /title="Keep notes on this run\."/);
	assert.doesNotMatch(tabs[2], /aria-label=/);
	assert.match(markup, />Notes</);
});

test('descriptions are per entry: a mixed menu describes only the entries that say', () => {
	const tabs = tabTags(
		render({
			entries: [
				{ id: 'a', label: 'A', description: 'What A is for.' },
				{ id: 'b', label: 'B' },
			],
		})
	);
	assert.match(tabs[0], /title="What A is for\."/);
	assert.doesNotMatch(tabs[1], /title=/);
});
