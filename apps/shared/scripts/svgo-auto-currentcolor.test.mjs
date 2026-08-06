// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { optimize } from 'svgo';
import plugin from './svgo-auto-currentcolor.mjs';

// Run svgo with ONLY our plugin so the output reflects our transform alone
// (no preset-default minification or attribute reordering noise).
const run = (input) => optimize(input, { plugins: [plugin] }).data;

// Run svgo with the same plugin chain used in production (preset-default first,
// then our plugin). removeComments must be disabled in preset-default so the
// <!-- preserve-colors --> marker survives to our plugin.
const runWithPreset = (input) =>
	optimize(input, {
		plugins: [
			{
				name: 'preset-default',
				params: { overrides: { removeViewBox: false, removeComments: false } },
			},
			plugin,
		],
	}).data;

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg">';
const SVG_CLOSE = '</svg>';
const wrap = (inner) => `${SVG_OPEN}${inner}${SVG_CLOSE}`;

describe('svgo-auto-currentcolor — rewrites monochrome SVGs', () => {
	test('single fill attribute on one path', () => {
		const out = run(wrap('<path fill="#000" d="M0 0h10v10H0z"/>'));
		assert.match(out, /fill="currentColor"/);
		assert.doesNotMatch(out, /fill="#000"/);
	});

	test('single stroke color across multiple paths', () => {
		const out = run(
			wrap('<path stroke="#fff" d="M0 0L10 10"/><path stroke="#fff" d="M0 10L10 0"/>'),
		);
		const matches = out.match(/stroke="currentColor"/g) ?? [];
		assert.equal(matches.length, 2);
		assert.doesNotMatch(out, /stroke="#fff"/);
	});

	test('single fill defined via inline style attribute', () => {
		const out = run(wrap('<path style="fill: #333" d="M0 0h10v10H0z"/>'));
		assert.match(out, /fill:\s*currentColor/);
		assert.doesNotMatch(out, /#333/);
	});

	test('single fill defined inside an embedded <style> block', () => {
		const input = wrap(
			'<style>.cls-1 { fill: #222; }</style><path class="cls-1" d="M0 0h10v10H0z"/>',
		);
		const out = run(input);
		assert.match(out, /fill:\s*currentColor/);
		assert.doesNotMatch(out, /#222/);
	});

	test('same color via attribute + inline style + <style> block — all rewritten', () => {
		const input = wrap(
			'<style>.cls-1 { fill: #444; }</style>' +
				'<path fill="#444" d="M0 0L1 1"/>' +
				'<path style="fill: #444" d="M2 2L3 3"/>' +
				'<path class="cls-1" d="M4 4L5 5"/>',
		);
		const out = run(input);
		assert.doesNotMatch(out, /#444/);
		assert.match(out, /fill="currentColor"/);
		assert.match(out, /fill:\s*currentColor/);
	});

	test('idempotent on SVG that already uses currentColor', () => {
		const input = wrap('<path fill="currentColor" d="M0 0h10v10H0z"/>');
		const out = run(input);
		assert.match(out, /fill="currentColor"/);
	});

	test('single color with #abc shorthand normalizes to #aabbcc', () => {
		// #abc and #aabbcc represent the same color — should count as 1 color.
		const input = wrap('<path fill="#abc"/><path fill="#aabbcc"/>');
		const out = run(input);
		const matches = out.match(/fill="currentColor"/g) ?? [];
		assert.equal(matches.length, 2);
	});

	test('single color with multiple opacity values still counts as one color', () => {
		const input = wrap(
			'<path fill="#000" fill-opacity="0.5" d="M0 0h5v5H0z"/>' +
				'<path fill="#000" fill-opacity="1" d="M5 5h5v5H5z"/>',
		);
		const out = run(input);
		const matches = out.match(/fill="currentColor"/g) ?? [];
		assert.equal(matches.length, 2);
	});

	test('single named color (red) is detected and rewritten', () => {
		const input = wrap('<path fill="red" d="M0 0L1 1"/>');
		const out = run(input);
		assert.match(out, /fill="currentColor"/);
	});
});

describe('svgo-auto-currentcolor — leaves multicolor SVGs alone', () => {
	test('two different fill colors', () => {
		const input = wrap('<path fill="#f00" d="M0 0L1 1"/><path fill="#0f0" d="M1 1L2 2"/>');
		const out = run(input);
		assert.match(out, /fill="#f00"/);
		assert.match(out, /fill="#0f0"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('one fill plus a different stroke', () => {
		const input = wrap('<path fill="#f00" stroke="#0f0" d="M0 0L1 1"/>');
		const out = run(input);
		assert.match(out, /fill="#f00"/);
		assert.match(out, /stroke="#0f0"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('linearGradient forces multicolor treatment', () => {
		const input = wrap(
			'<defs><linearGradient id="g"><stop stop-color="#000"/></linearGradient></defs>' +
				'<path fill="#000" d="M0 0L1 1"/>',
		);
		const out = run(input);
		assert.match(out, /fill="#000"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('radialGradient forces multicolor treatment', () => {
		const input = wrap(
			'<defs><radialGradient id="g"><stop stop-color="#000"/></radialGradient></defs>' +
				'<path fill="#000" d="M0 0L1 1"/>',
		);
		const out = run(input);
		assert.match(out, /fill="#000"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('pattern element forces multicolor treatment', () => {
		const input = wrap(
			'<defs><pattern id="p" width="4" height="4"><path fill="#000" d="M0 0L1 1"/></pattern></defs>' +
				'<path fill="#000" d="M0 0L1 1"/>',
		);
		const out = run(input);
		// At least one #000 remains (pattern blocks rewrite).
		assert.match(out, /fill="#000"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('dark logo with white cutouts (two distinct fills) is left alone', () => {
		// Common pattern: black logo body with white cutouts via even-odd or layered paths.
		// We treat this as multicolor by policy.
		const input = wrap('<path fill="#000" d="M0 0h10v10H0z"/><path fill="#fff" d="M3 3h4v4H3z"/>');
		const out = run(input);
		assert.match(out, /fill="#000"/);
		assert.match(out, /fill="#fff"/);
		assert.doesNotMatch(out, /currentColor/);
	});
});

describe('svgo-auto-currentcolor — preserve-colors opt-out comment', () => {
	test('single-color SVG with <!-- preserve-colors --> is left unchanged', () => {
		const input = `<!-- preserve-colors -->${wrap('<path fill="#fb5e1a" d="M0 0h10v10H0z"/>')}`;
		const out = run(input);
		assert.match(out, /fill="#fb5e1a"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('preserve-colors comment inside the svg element is also honoured', () => {
		const input = wrap('<!-- preserve-colors --><path fill="#ffcc00" d="M0 0h10v10H0z"/>');
		const out = run(input);
		assert.match(out, /fill="#ffcc00"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('single-color SVG without the comment is still rewritten', () => {
		const out = run(wrap('<path fill="#fb5e1a" d="M0 0h10v10H0z"/>'));
		assert.match(out, /fill="currentColor"/);
		assert.doesNotMatch(out, /#fb5e1a/);
	});

	test('preserve-colors survives the full production plugin chain (preset-default + autoCurrentColor)', () => {
		// Regression: preset-default's removeComments was stripping the marker
		// before autoCurrentColor ran, causing all single-color brand SVGs to be
		// tinted regardless of the opt-out comment.
		const input = wrap('<!-- preserve-colors --><path fill="#fb5e1a" d="M0 0h10v10H0z"/>');
		const out = runWithPreset(input);
		assert.match(out, /fill="#fb5e1a"/);
		assert.doesNotMatch(out, /currentColor/);
	});

	test('single-color SVG without comment is still tinted through the full chain', () => {
		const out = runWithPreset(wrap('<path fill="#fb5e1a" d="M0 0h10v10H0z"/>'));
		assert.match(out, /fill="currentColor"/);
		assert.doesNotMatch(out, /#fb5e1a/);
	});
});

describe('svgo-auto-currentcolor — ignored values do not count as colors', () => {
	test('fill="none" is ignored when counting colors', () => {
		// One real color (#000) + one fill="none" → counts as 1 color → rewrite the real one.
		const input = wrap('<path fill="none" stroke="#000" d="M0 0L1 1"/>');
		const out = run(input);
		assert.match(out, /stroke="currentColor"/);
		// fill="none" should be preserved (we only touch real colors).
		assert.match(out, /fill="none"/);
	});

	test('fill="transparent" is ignored when counting colors', () => {
		const input = wrap('<path fill="transparent" stroke="#000" d="M0 0L1 1"/>');
		const out = run(input);
		assert.match(out, /stroke="currentColor"/);
	});

	test('fill="currentColor" is ignored when counting; other color is the unique color', () => {
		const input = wrap(
			'<path fill="currentColor" d="M0 0L1 1"/><path fill="#222" d="M1 1L2 2"/>',
		);
		const out = run(input);
		// Both should end up as currentColor (one already was, the other gets rewritten).
		const matches = out.match(/fill="currentColor"/g) ?? [];
		assert.equal(matches.length, 2);
		assert.doesNotMatch(out, /#222/);
	});

	test('url(#gradient) references do not count as colors', () => {
		// A url() ref usually points to a gradient — but the gradient ELEMENT presence
		// is what marks multicolor. Here we test the value-ignoring rule alone.
		const input = wrap('<path fill="url(#nonexistent)" stroke="#333" d="M0 0L1 1"/>');
		const out = run(input);
		assert.match(out, /stroke="currentColor"/);
		assert.match(out, /fill="url\(#nonexistent\)"/);
	});
});
