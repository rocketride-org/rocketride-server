// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// IMAGE EXPORT: the SVG is built from the canvas's own layout data
// =============================================================================
//
// The export does not rasterise the page (no DOM-to-image library): it writes an SVG from
// the positions, colours, captions, badges and relationship geometry the canvas already
// holds. Colours on the canvas are CSS variables, which mean nothing outside the page, so
// every colour is resolved first. PNG is that SVG drawn into a canvas, in the browser only.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSvg, exportResult, pngScale } from '../src/canvas/exportImage';
import type { IExportEdge, IExportNode, IExportTheme } from '../src/canvas/exportImage';
import { edgeSlots } from '../src/graph/geometry';

const THEME: IExportTheme = { background: 'var(--rr-bg-default)', text: 'var(--rr-text-primary)', halo: 'var(--rr-bg-paper)', border: 'var(--rr-text-primary)', accent: 'var(--rr-border-focus)' };
const COLOURS: Record<string, string> = { '--rr-bg-default': '#101418', '--rr-text-primary': '#f0f0f0', '--rr-bg-paper': '#1a1f24', '--rr-border-focus': '#4da3ff', '--rr-chart-1': '#3366cc', '--rr-text-secondary': '#a0a0a0' };
const resolve = (css: string): string => {
	const variable = /^var\((--[a-z0-9-]+)/i.exec(css);
	return variable ? COLOURS[variable[1]] ?? css : css;
};
const nodeAt = (id: string, x: number, caption: string, extra: Partial<IExportNode> = {}): IExportNode => ({ id, x, y: 0, radius: 28, fill: 'var(--rr-chart-1)', textColor: '#ffffff', badge: 'P', badgeMode: 'initials', caption, dim: false, stale: false, selected: false, ...extra });
const edge = (extra: Partial<IExportEdge> = {}): IExportEdge => ({ id: 'r', source: 'a', target: 'b', slot: edgeSlots([{ id: 'r', source: 'a', target: 'b' }]).get('r')!, type: 'KNOWS', stroke: 'var(--rr-text-secondary)', width: 1.4, dashed: false, dim: false, ...extra });
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

test('two nodes and one relationship: two circles, one line with its arrow, the captions and badges, and every colour resolved', () => {
	const out = buildSvg([nodeAt('a', 0, 'Ada'), nodeAt('b', 300, 'Maya')], [edge()], THEME, { resolve, labels: true });
	assert.ok(out);
	const svg = out.svg;
	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
	assert.equal(count(svg, /<circle /g), 2);
	assert.equal(count(svg, /<path /g), 1);
	assert.equal(count(svg, /<polygon /g), 1, 'the arrow head');
	assert.doesNotMatch(svg, /var\(/, 'no CSS variable is left: they mean nothing outside the page');
	assert.match(svg, /fill="#3366cc"/);
	assert.match(svg, /stroke="#a0a0a0"/);
	assert.match(svg, /<rect [^>]*fill="#101418"/, 'the canvas background is painted');
	assert.match(svg, />Ada<\/text>/);
	assert.match(svg, />Maya<\/text>/);
	assert.match(svg, />P<\/text>/);
	assert.match(svg, />KNOWS<\/text>/);
	assert.ok(out.width > 300 + 56 && out.height > 56, 'the whole drawing plus a margin');
	assert.match(svg, new RegExp(`width="${out.width}" height="${out.height}"`));
});

test('text is escaped, long captions are cut, and a colour that cannot be resolved falls back to a plain one', () => {
	const out = buildSvg([nodeAt('a', 0, '<b>&"Tom\'s"</b>'), nodeAt('b', 300, 'x'.repeat(80), { fill: 'var(--unknown)' })], [edge({ type: 'A&B' })], THEME, { resolve, labels: true });
	assert.ok(out);
	assert.match(out.svg, />&lt;b&gt;&amp;&quot;Tom&#39;s&quot;&lt;\/b&gt;<\/text>/);
	assert.match(out.svg, />A&amp;B<\/text>/);
	assert.doesNotMatch(out.svg, /x{80}/);
	assert.match(out.svg, /x+…<\/text>/);
	assert.doesNotMatch(out.svg, /var\(/);
});

// XML 1.0 has no place for most control characters or for half a surrogate pair: one of them in a caption (a property
// value can hold anything) makes the whole SVG unreadable, and the PNG, drawn from it, silently fails.
test('characters XML cannot hold become U+FFFD, so one odd property value never breaks the file', () => {
	const odd = `A\u0001B\u0008C\u000bD\u000cE\u001fF\ufffeG\uffffH\ud800I\udc00J`;
	const out = buildSvg([nodeAt('a', 0, odd), nodeAt('b', 300, 'Tab\tand\nnewline', { badge: '\u0000' })], [edge({ type: 'T\u0002' })], THEME, { resolve, labels: true });
	assert.ok(out);
	assert.match(out.svg, />A\ufffdB\ufffdC\ufffdD\ufffdE\ufffdF\ufffdG\ufffdH\ufffdI\ufffdJ<\/text>/);
	assert.match(out.svg, />T\ufffd<\/text>/);
	assert.match(out.svg, />\ufffd<\/text>/, 'a badge too');
	assert.match(out.svg, /Tab\tand\nnewline/, 'tab and newline are allowed in XML and kept');
	const emoji = buildSvg([nodeAt('a', 0, 'Smile 😀')], [], THEME, { resolve, labels: true });
	assert.match(emoji?.svg ?? '', />Smile 😀<\/text>/, 'a whole surrogate pair is kept');
	// Nothing XML 1.0 forbids is left anywhere in the file.
	for (let i = 0; i < out.svg.length; i++) {
		const code = out.svg.charCodeAt(i);
		assert.ok(!(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) && code !== 0xfffe && code !== 0xffff, `U+${code.toString(16)} at ${i}`);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = out.svg.charCodeAt(i + 1);
			assert.ok(next >= 0xdc00 && next <= 0xdfff, `half a surrogate pair at ${i}`);
			i += 1;
		} else {
			assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `half a surrogate pair at ${i}`);
		}
	}
});

test('what the canvas shows is what is exported: badges by mode, the selection ring, dashed out-of-date lines, dimmed elements, labels only when asked', () => {
	const out = buildSvg(
		[nodeAt('a', 0, 'A', { badgeMode: 'dot', selected: true }), nodeAt('b', 300, 'B', { badgeMode: 'none', dim: true, stale: true })],
		[edge({ dashed: true, dim: true, stroke: 'var(--rr-border-focus)', width: 3 })],
		THEME,
		{ resolve, labels: false }
	);
	assert.ok(out);
	assert.equal(count(out.svg, /<circle /g), 4, 'two nodes, a dot badge and a selection ring');
	assert.doesNotMatch(out.svg, />P<\/text>/, 'no initials in dot or none mode');
	assert.match(out.svg, /stroke-dasharray="5 4"/);
	assert.match(out.svg, /opacity="0\.2"/);
	assert.match(out.svg, /stroke="#4da3ff" stroke-width="3"/);
	assert.doesNotMatch(out.svg, />KNOWS</, 'labels left out when the drawing hides them');
});

test('nothing drawn, nothing to export; the PNG scale stays inside what a browser canvas can hold', () => {
	assert.equal(buildSvg([], [], THEME, { resolve, labels: true }), null);
	assert.equal(pngScale(800, 600), 2);
	assert.ok(pngScale(12000, 400) * 12000 <= 16384);
	assert.ok(pngScale(9000, 9000) ** 2 * 9000 * 9000 <= 16_777_216 + 1, 'within Safari\'s canvas area');
	assert.ok(pngScale(3000, 2000) ** 2 * 3000 * 2000 <= 16_777_216 + 1);
	assert.equal(pngScale(2e6, 10), 0, 'too big to draw at any useful size');
});

// "No image" has several causes and the view words each one: only a PNG that would be under a quarter of its size is
// "too large"; nothing laid out yet is "not ready"; a browser that could not draw it is "render failed".
test('exportResult says why there is no image: too large only for a PNG past the canvas limit, not ready with nothing drawn, render failed when the browser could not draw it', async () => {
	const built = buildSvg([nodeAt('a', 0, 'A'), nodeAt('b', 300, 'B')], [edge()], THEME, { resolve, labels: true });
	assert.ok(built);
	const png = new Blob(['png'], { type: 'image/png' });
	const asked: number[] = [];
	const ok = await exportResult('png', built, async (_svg, _w, _h, scale) => {
		asked.push(scale);
		return png;
	});
	assert.equal(ok.blob, png);
	assert.deepEqual(asked, [2], 'drawn at twice the size');
	const svg = await exportResult('svg', built, async () => assert.fail('an SVG is not rasterised'));
	assert.equal(svg.blob?.type, 'image/svg+xml');
	assert.equal(await svg.blob?.text(), built.svg);
	assert.deepEqual(await exportResult('png', null, async () => png), { blob: null, reason: 'not-ready' });
	assert.deepEqual(await exportResult('svg', null, async () => png), { blob: null, reason: 'not-ready' });
	const huge = { svg: '<svg/>', width: 70_000, height: 100 };
	assert.deepEqual(await exportResult('png', huge, async () => assert.fail('not tried')), { blob: null, reason: 'too-large' });
	assert.equal((await exportResult('svg', huge, async () => png)).blob?.type, 'image/svg+xml', 'the SVG has no size limit');
	assert.deepEqual(await exportResult('png', built, async () => null), { blob: null, reason: 'render-failed' }, 'no 2D context, an image that did not load, toBlob gave nothing');
	assert.deepEqual(await exportResult('png', built, async () => { throw new Error('tainted'); }), { blob: null, reason: 'render-failed' });
});
