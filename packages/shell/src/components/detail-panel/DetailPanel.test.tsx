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
import { renderToStaticMarkup } from 'react-dom/server';
import { DetailPanel } from './DetailPanel';

test('DetailPanel tabs show an entry description as the tooltip, like TabControl', () => {
	const markup = renderToStaticMarkup(
		<DetailPanel
			open
			onClose={() => undefined}
			title="Run"
			tabs={[
				{ id: 'summary', label: 'Summary', description: '  What the run did, at a glance. ' },
				{ id: 'raw', label: 'Raw' },
				{ id: 'empty', label: 'Empty', description: '' },
				{ id: 'blank', label: 'Blank', description: '   ' },
			]}
			activeTab="summary"
		>
			body
		</DetailPanel>
	);
	const tabs = markup.match(/<div[^>]*role="tab"[^>]*>/g) ?? [];
	assert.equal(tabs.length, 4);
	// Trimmed, like TabControl.
	assert.match(tabs[0], /title="What the run did, at a glance\."/);
	// Absent, empty and whitespace-only descriptions render no attribute.
	for (const tab of tabs.slice(1)) assert.doesNotMatch(tab, /title=/);
	assert.doesNotMatch(markup, /aria-description=/);
});
