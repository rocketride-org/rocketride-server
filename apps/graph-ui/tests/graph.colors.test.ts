// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LABEL COLOURS, CONTRAST (measured against every shipped theme) AND CAPTIONS
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CHART_COLOR_VARS, assignLabelColors, colorFor, composite, contrastRatio, hashColor, parseColor, readableOn, stableHash } from '../src/graph/colors';
import type { Rgb } from '../src/graph/colors';
import { CAPTION_ID, CAPTION_LABEL, CAPTION_MAX_CHARS, captionChoices, captionOf, defaultCaptionKey } from '../src/graph/captions';
import { CANVAS_RULES } from '../src/canvas/environment';
import { legendOf } from '../src/graph/legend';
import { modelFromResult } from '../src/graph/model';
import { entitiesOf, node } from './support/builders';

test('the first six labels (sorted) take the chart colours in order; the rest hash', () => {
	const labels = ['Zebra', 'Apple', 'Mango', 'Cherry', 'Banana', 'Fig', 'Grape', 'Date'];
	const colors = assignLabelColors(labels);
	const sorted = [...labels].sort();
	sorted.slice(0, 6).forEach((label, i) => assert.deepEqual(colors.get(label), { label, fill: `var(${CHART_COLOR_VARS[i]})`, slot: i }));
	for (const label of sorted.slice(6)) {
		assert.equal(colors.get(label)?.slot, null);
		assert.equal(colors.get(label)?.fill, hashColor(label));
	}
	assert.equal(colors.size, 8);
});

test('colours do not depend on input order or duplicates, and are stable across calls', () => {
	const a = assignLabelColors(['B', 'A', 'C', 'A']);
	const b = assignLabelColors(['C', 'A', 'B']);
	assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
	assert.equal(stableHash('Person'), stableHash('Person'));
	assert.notEqual(stableHash('Person'), stableHash('Persons'));
	assert.equal(hashColor('Person'), hashColor('Person'));
	assert.match(hashColor('Person'), /^hsl\(\d{1,3}, 55%, 46%\)$/);
	// The documented FNV-1a value for the empty string and for "a".
	assert.equal(stableHash(''), 0x811c9dc5);
	assert.equal(stableHash('a'), 0xe40c292c);
});

test('a label the schema does not know falls back to its hash; an unlabelled node is grey', () => {
	const colors = assignLabelColors(['A']);
	assert.equal(colorFor(colors, 'Unknown').fill, hashColor('Unknown'));
	assert.equal(colorFor(colors, 'A').slot, 0);
	assert.equal(colorFor(colors, '').fill, 'var(--rr-grey-400)');
	assert.equal(colorFor(colors, undefined).fill, 'var(--rr-grey-400)');
});

test('contrast arithmetic matches the WCAG reference values', () => {
	const black = { r: 0, g: 0, b: 0 };
	const white = { r: 255, g: 255, b: 255 };
	assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
	assert.equal(contrastRatio(white, white), 1);
	assert.ok(Math.abs(contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, white) - 4.54) < 0.01, '#767676 on white is the classic 4.54:1');
	assert.deepEqual(parseColor('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc });
	assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30 });
	assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0 });
	assert.equal(parseColor('var(--x)'), null);
	assert.deepEqual(composite({ r: 255, g: 255, b: 255 }, 0.4, { r: 22, g: 22, b: 22 }), { r: 115, g: 115, b: 115 });
	assert.equal(readableOn(white), '#000000');
	assert.equal(readableOn(black), '#ffffff');
});

// -----------------------------------------------------------------------------
// Measured against the shipped themes (packages/shell/public/themes/*.json)
// -----------------------------------------------------------------------------

const THEME_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'shell', 'public', 'themes');
const themes = fs
	.readdirSync(THEME_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => ({ name: f.replace(/\.json$/, ''), tokens: JSON.parse(fs.readFileSync(path.join(THEME_DIR, f), 'utf8')) as Record<string, string> }));

/** Opaque colour of a token over the theme's paper (handles rgba text tokens). */
function tokenOverPaper(tokens: Record<string, string>, name: string): Rgb {
	const paper = parseColor(tokens['--rr-bg-paper']) as Rgb;
	const raw = tokens[name];
	const rgb = parseColor(raw) as Rgb;
	const alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(raw);
	return alpha ? composite(rgb, Number(alpha[1]), paper) : rgb;
}

test('every shipped theme defines the six chart colours and the tokens the canvas uses', () => {
	assert.ok(themes.length >= 6, `found ${themes.length} themes`);
	for (const { name, tokens } of themes) {
		for (const variable of [...CHART_COLOR_VARS, '--rr-bg-paper', '--rr-text-primary', '--rr-text-secondary', '--rr-border', '--rr-palette-mode']) assert.ok(tokens[variable], `${name} lacks ${variable}`);
	}
});

test('the node outline and caption text (text-primary) clear 4.5:1 against the page in every theme', () => {
	for (const { name, tokens } of themes) {
		const paper = parseColor(tokens['--rr-bg-paper']) as Rgb;
		const ratio = contrastRatio(tokenOverPaper(tokens, '--rr-text-primary'), paper);
		assert.ok(ratio >= 4.5, `${name}: text-primary on paper is ${ratio.toFixed(2)}:1`);
	}
});

test('a label name drawn in a chart colour or in the outline colour is readable on the fill, in every theme', () => {
	const rows: string[] = [];
	for (const { name, tokens } of themes) {
		for (const variable of CHART_COLOR_VARS) {
			const fill = parseColor(tokens[variable]) as Rgb;
			const best = Math.max(contrastRatio(fill, { r: 0, g: 0, b: 0 }), contrastRatio(fill, { r: 255, g: 255, b: 255 }));
			rows.push(`${name} ${variable} best-text ${best.toFixed(2)}`);
			assert.ok(best >= 4.5, `${name} ${variable}: best text colour on the fill is only ${best.toFixed(2)}:1`);
		}
	}
	assert.ok(rows.length >= 36);
});

test('MEASURED: chart colours below 3:1 against the page need the outline (recorded per theme)', () => {
	// This is the measurement the design asks for, made executable. The assertion
	// is not "all colours pass" - they do not - it is that every colour that fails
	// 3:1 against the page is one the outline protects, which holds because the
	// outline colour itself clears 3:1 (tested above) and every node has one.
	const failing: Record<string, string[]> = {};
	for (const { name, tokens } of themes) {
		const paper = parseColor(tokens['--rr-bg-paper']) as Rgb;
		for (const variable of CHART_COLOR_VARS) {
			const ratio = contrastRatio(parseColor(tokens[variable]) as Rgb, paper);
			if (ratio < 3) (failing[name] ??= []).push(`${variable.replace('--rr-chart-', '')} ${ratio.toFixed(2)}`);
		}
	}
	// Written to the test output so the numbers reach the report.
	console.log('chart colours under 3:1 against --rr-bg-paper (outlined for this reason):', JSON.stringify(failing));
	for (const { name, tokens } of themes) {
		const paper = parseColor(tokens['--rr-bg-paper']) as Rgb;
		assert.ok(contrastRatio(tokenOverPaper(tokens, '--rr-text-primary'), paper) >= 3, `${name}: the outline colour must itself clear 3:1`);
	}
});

test('hashed colours (fixed saturation and lightness) always have a readable text colour', () => {
	for (let i = 0; i < 400; i++) {
		const rgb = parseColor(hashColor(`Label${i}`)) as Rgb;
		const best = Math.max(contrastRatio(rgb, { r: 0, g: 0, b: 0 }), contrastRatio(rgb, { r: 255, g: 255, b: 255 }));
		assert.ok(best >= 4.5, `Label${i}: ${best.toFixed(2)}`);
	}
});

// -----------------------------------------------------------------------------
// Captions
// -----------------------------------------------------------------------------

test('the default caption is the first sensible property, then any text property, then the label, then the id', () => {
	assert.equal(defaultCaptionKey(node('1', ['P'], { age: 3, Name: 'Alice', title: 'x' })), 'Name', 'case-insensitive, priority order');
	assert.equal(defaultCaptionKey(node('1', ['P'], { zzz: 'text', aaa: 'text' })), 'aaa', 'first text property alphabetically');
	assert.equal(defaultCaptionKey(node('1', ['P'], { age: 3 })), CAPTION_LABEL);
	assert.equal(defaultCaptionKey(node('1', [], {})), CAPTION_ID);
	assert.equal(defaultCaptionKey(node('1', ['P'], { name: '' , title: 'T' })), 'title', 'an empty name is skipped');
	assert.equal(defaultCaptionKey(node('1', ['P'], { id: 42 })), 'id', 'a number is showable');
});

test('captions use the user choice, fall back per node, and are bounded single-line text', () => {
	const n = node('node-id-1', ['Person', 'Employee'], { name: 'Alice', city: 'Berlin' });
	assert.equal(captionOf(n), 'Alice');
	assert.equal(captionOf(n, 'city'), 'Berlin');
	assert.equal(captionOf(n, CAPTION_ID), 'node-id-1');
	assert.equal(captionOf(n, CAPTION_LABEL), 'Person');
	assert.equal(captionOf(n, 'missing'), 'Alice', 'a property this node lacks falls back to its default');
	assert.equal(captionOf(node('only-id', [], {}), 'missing'), 'only-id');
	const long = captionOf(node('1', ['P'], { name: 'x'.repeat(100) }));
	assert.equal(long.length, CAPTION_MAX_CHARS);
	assert.ok(long.endsWith('…'));
	assert.equal(captionOf(node('1', ['P'], { name: 'a\n\n  b\tc' })), 'a b c');
	assert.equal(captionOf(node('1', ['P'], { name: { '@kind': 'number', value: '9007199254740993' } })), '9007199254740993');
});

test('a property whose name starts with @ is found by the name the user wrote (the wire key has one extra @)', () => {
	const n = node('1', ['P'], { '@@kind': 'tagged-looking', '@@name': 'at-name', plain: 'p' });
	assert.equal(captionOf(n, '@kind'), 'tagged-looking');
	assert.equal(captionOf(n, '@name'), 'at-name');
	assert.equal(defaultCaptionKey(node('1', ['P'], { '@@name': 'shown' })), '@name', 'the user wrote @name; the wire key is @@name');
	assert.equal(defaultCaptionKey(node('1', ['P'], { '@name': 'shown' })), 'name', 'the wire key @name decodes to name');
});

test('caption choices list property names most common first, then the two special choices', () => {
	const choices = captionChoices([node('1', ['P'], { name: 'a', age: 1 }), node('2', ['P'], { name: 'b' }), node('3', ['P'], { zip: 'z', name: 'c' })]);
	assert.deepEqual(choices.map((c) => c.value), ['name', 'age', 'zip', CAPTION_LABEL, CAPTION_ID]);
	assert.deepEqual(captionChoices([]).map((c) => c.value), [CAPTION_LABEL, CAPTION_ID]);
});

test('the node outline is unconditional: one plain rule, not nested in a media or supports block, and focus is always visible', () => {
	const rules = CANVAS_RULES.split('\n');
	const outline = rules.find((r) => r.includes('.graph-ui-circle') && r.includes('border: 1px solid var(--rr-text-primary)'));
	assert.ok(outline, 'the circle has a 1px --rr-text-primary border');
	assert.ok(!outline.trimStart().startsWith('@'), 'and it is not behind an at-rule');
	assert.ok(rules.some((r) => r.includes(':focus-visible') && r.includes('outline: 3px solid')), 'a thick focus ring on the focused node');
	// Motion is opt-in: the only transition lives under prefers-reduced-motion: no-preference.
	const transitions = rules.filter((r) => r.includes('transition'));
	assert.ok(transitions.length > 0 && transitions.every((r) => r.startsWith('@media (prefers-reduced-motion: no-preference)')));
});

test('the legend names every label on the canvas with its colour and a count of the DRAWN nodes', () => {
	const model = modelFromResult(entitiesOf([node('1', ['Person']), node('2', ['Person', 'Employee']), node('3', ['Company']), node('4', []), node('5', ['Person'])], []));
	const colors = assignLabelColors(['Company', 'Person', 'Employee']);
	const legend = legendOf(model, colors);
	assert.deepEqual(legend.map((e) => [e.name, e.count]), [['Person', 3], ['(no label)', 1], ['Company', 1]], 'Employee is a second label: it does not set the colour, so it is not a legend line');
	assert.equal(legend[0].fill, 'var(--rr-chart-red)', 'sorted labels Company, Employee, Person take blue, green, red');
	assert.equal(legend.find((e) => e.name === '(no label)')?.fill, 'var(--rr-grey-400)');
	assert.deepEqual(legendOf(modelFromResult(entitiesOf([], [])), colors), []);
});
