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

/**
 * Unit tests for the pure extraction/resolution helpers of
 * `generate-gallery-tokens.mjs` (node:test, run via shared-ui:test).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractCommonStyleRefs, extractTokens, parseStyleBlocks, renderModule, resolveStyleTokens } from './generate-gallery-tokens.mjs';

// =============================================================================
// TOKEN EXTRACTION
// =============================================================================

test('extractTokens dedupes and sorts --rr tokens', () => {
	const text = "color: 'var(--rr-text-primary)', background: 'var(--rr-bg-default)', border: '1px solid var(--rr-text-primary)'";
	assert.deepEqual(extractTokens(text), ['--rr-bg-default', '--rr-text-primary']);
});

test('extractTokens returns empty array for token-free text', () => {
	assert.deepEqual(extractTokens('const x = 1;'), []);
});

// =============================================================================
// COMMON STYLES REFERENCES
// =============================================================================

test('extractCommonStyleRefs finds spread and call references', () => {
	const text = 'const a = { ...commonStyles.buttonPrimary }; const b = commonStyles.listRow(true); commonStyles.fontMono;';
	assert.deepEqual(extractCommonStyleRefs(text), ['buttonPrimary', 'fontMono', 'listRow']);
});

// =============================================================================
// STYLE BLOCK PARSING + TRANSITIVE RESOLUTION
// =============================================================================

/** A miniature styles.ts: base -> variant chain plus a function-form const. */
const STYLES_FIXTURE = `
const base: CSSProperties = {
	color: 'var(--rr-text-primary)',
};

const variant: CSSProperties = {
	...base,
	background: 'var(--rr-bg-widget)',
};

const rowStyle = (active) => ({
	background: active ? 'var(--rr-bg-list-active)' : 'transparent',
});
`;

test('parseStyleBlocks captures object and function consts', () => {
	const blocks = parseStyleBlocks(STYLES_FIXTURE);
	assert.deepEqual([...blocks.keys()].sort(), ['base', 'rowStyle', 'variant']);
	assert.deepEqual(blocks.get('variant').refs, ['base']);
	assert.deepEqual(blocks.get('rowStyle').tokens, ['--rr-bg-list-active']);
});

test('resolveStyleTokens follows spreads transitively', () => {
	const blocks = parseStyleBlocks(STYLES_FIXTURE);
	assert.deepEqual(resolveStyleTokens('variant', blocks, new Map()), ['--rr-bg-widget', '--rr-text-primary']);
});

test('resolveStyleTokens tolerates unknown names and cycles', () => {
	const blocks = parseStyleBlocks('const a: CSSProperties = {\n\t...b,\n};\nconst b: CSSProperties = {\n\t...a,\n};\n');
	assert.deepEqual(resolveStyleTokens('missing', blocks, new Map()), []);
	assert.deepEqual(resolveStyleTokens('a', blocks, new Map()), []);
});

// =============================================================================
// MODULE RENDERING
// =============================================================================

test('renderModule emits deterministic sorted entries', () => {
	const usage = {
		'b-entry': { direct: ['--rr-brand'], commonStyles: {} },
		'a-entry': { direct: [], commonStyles: { fontMono: ['--rr-font-mono'] } },
	};
	const rendered = renderModule(usage);
	// Sorted entry order, sorted style keys, and the do-not-edit marker
	assert.ok(rendered.indexOf("'a-entry'") < rendered.indexOf("'b-entry'"));
	assert.ok(rendered.includes('AUTO-GENERATED, DO NOT EDIT'));
	assert.ok(rendered.includes("fontMono: ['--rr-font-mono']"));
});
