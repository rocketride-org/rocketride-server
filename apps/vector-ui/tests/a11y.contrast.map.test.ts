// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// A11Y CONTRAST OF THE MAP: every colour the map draws, in all six shipped themes
// =============================================================================
//
// The map sits on --rr-bg-default and its panels on --rr-bg-paper; each drawn
// colour is measured against BOTH in every theme (WCAG 1.4.11 graphics 3:1,
// 1.4.3 text 4.5:1). A point colour that cannot clear 3:1 is never left alone:
// it gets the 1 px outline, whose own colour is measured here.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IDocumentItem, ISampleResult } from '../src/contract/types';
import { categoricalColour, clusterColours, colourPoints, rampStops } from '../src/map/colours';
import { contrastRatio, opaqueOver, parseColor } from '../src/map/contrast';
import type { Rgb } from '../src/map/contrast';
import { ACCENT_TOKEN, CHART_COLOR_VARS, MAP_SURFACES, MIN_GRAPHIC_CONTRAST, MIN_TEXT_CONTRAST, OTHER_TOKEN, OUTLINE_TOKEN, TEXT_TOKEN, readPalette } from '../src/map/tokens';

const THEME_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'shell', 'public', 'themes');
const themes = fs
	.readdirSync(THEME_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => ({ name: f.replace(/\.json$/, ''), tokens: JSON.parse(fs.readFileSync(path.join(THEME_DIR, f), 'utf8')) as Record<string, string> }));

/** Contrast of a colour (token value or CSS colour) drawn over a surface token of a theme. */
function ratio(tokens: Record<string, string>, colour: string, surface: string): number {
	const bg = parseColor(tokens[surface] as string) as Rgb;
	return contrastRatio(opaqueOver(colour, bg) as Rgb, bg);
}

/** Assert a colour clears a minimum on both surfaces; returns the two ratios. */
function clears(name: string, tokens: Record<string, string>, colour: string, minimum: number, what: string): string {
	return MAP_SURFACES.map((surface) => {
		const r = ratio(tokens, colour, surface);
		assert.ok(r >= minimum, `${what} (${colour}) on ${surface} in ${name}: ${r.toFixed(2)}:1 < ${minimum}:1`);
		return r.toFixed(2);
	}).join('/');
}

test('six shipped themes, each defining every token the map draws with', () => {
	assert.equal(themes.length, 6);
	for (const { name, tokens } of themes) for (const t of [ACCENT_TOKEN, OUTLINE_TOKEN, OTHER_TOKEN, TEXT_TOKEN, ...CHART_COLOR_VARS, ...MAP_SURFACES, '--rr-palette-mode']) assert.ok(tokens[t], `${name} lacks ${t}`);
});

test('selection ring, star, rays, neighbour links and lasso (the accent) clear 3:1 everywhere, and the accent is not the brand colour', () => {
	assert.equal(ACCENT_TOKEN, '--rr-border-focus');
	const rows = themes.map(({ name, tokens }) => `${name} ${clears(name, tokens, tokens[ACCENT_TOKEN] as string, MIN_GRAPHIC_CONTRAST, 'accent')}`);
	console.log('map accent (bg-default/bg-paper):', rows.join(' | '));
});

test('the point outline and the map\'s text (tooltip, labels) clear 4.5:1 everywhere', () => {
	assert.equal(OUTLINE_TOKEN, '--rr-text-primary');
	for (const { name, tokens } of themes) {
		clears(name, tokens, tokens[OUTLINE_TOKEN] as string, MIN_TEXT_CONTRAST, 'outline');
		clears(name, tokens, tokens[TEXT_TOKEN] as string, MIN_TEXT_CONTRAST, 'text');
	}
});

test('"Other" points and hollow out-of-sample neighbours clear 3:1 everywhere', () => {
	for (const { name, tokens } of themes) clears(name, tokens, tokens[OTHER_TOKEN] as string, MIN_GRAPHIC_CONTRAST, 'other');
});

test('the chart colours that fall below 3:1 are exactly the ones drawn with an outline (measured: yellow and orange in the light themes)', () => {
	const weak: string[] = [];
	for (const { name, tokens } of themes) {
		const palette = readPalette((t) => tokens[t] ?? '');
		CHART_COLOR_VARS.forEach((token, slot) => {
			const colour = categoricalColour(slot, `slot${slot}`, palette);
			const below = MAP_SURFACES.some((s) => ratio(tokens, colour.colour, s) < MIN_GRAPHIC_CONTRAST);
			assert.equal(colour.outlined, below, `${name} ${token}`);
			if (below) weak.push(`${name}:${token}`);
		});
	}
	console.log('chart colours drawn with an outline:', weak.join(', '));
	assert.ok(weak.length > 0 && weak.every((w) => /light|visual-studio/.test(w)), 'only light themes need outlines');
	assert.ok(weak.some((w) => w.endsWith('--rr-chart-yellow')));
});

test('the hashed category colours (slots 7-10) clear 3:1 for every hue in every theme, so they never need an outline', () => {
	for (const { name, tokens } of themes) {
		const palette = readPalette((t) => tokens[t] ?? '');
		for (let hue = 0; hue < 360; hue += 5) {
			const colour = categoricalColour(CHART_COLOR_VARS.length, `h${hue}`, palette, hue);
			clears(name, tokens, colour.colour, MIN_GRAPHIC_CONTRAST, `hashed hue ${hue}`);
			assert.equal(colour.outlined, false);
		}
	}
});

test('every step of the sequential ramp clears 3:1 in every theme', () => {
	for (const { name, tokens } of themes) {
		const stops = rampStops(readPalette((t) => tokens[t] ?? ''));
		assert.ok(stops.length >= 5);
		assert.equal(new Set(stops).size, stops.length, 'distinct steps');
		for (const stop of stops) clears(name, tokens, stop, MIN_GRAPHIC_CONTRAST, 'ramp');
	}
});

test('no map file draws with the brand colour', () => {
	const roots = [path.resolve(__dirname, '..', 'src', 'map'), path.resolve(__dirname, '..', 'src', 'components'), path.resolve(__dirname, '..', 'src', 'views')];
	const mine = /^(MapToolbar|PointCanvas|PointInspector|NeighbourList|DuplicatesPanel|OutliersPanel|PointsTable|Legend|HeatStrip|ClustersPanel|MapView)\.tsx$|\.ts$/;
	for (const root of roots) {
		for (const file of fs.readdirSync(root)) {
			if (root.endsWith('map') ? !file.endsWith('.ts') : !mine.test(file) || file.endsWith('.ts')) continue;
			const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			assert.doesNotMatch(text, /--rr-brand/, `${file} uses the brand colour`);
		}
	}
});

test('cluster colours, up to the node\'s 200 groups: distinct, and each clears 3:1 on both surfaces or is drawn with the outline', () => {
	for (const { name, tokens } of themes) {
		const palette = readPalette((t) => tokens[t] ?? '');
		const colours = clusterColours(200, palette);
		assert.equal(new Set(colours.map((c) => c.colour)).size, 200, `${name}: no two groups share a colour`);
		for (const [g, c] of colours.entries()) {
			const below = MAP_SURFACES.some((s) => ratio(tokens, c.colour, s) < MIN_GRAPHIC_CONTRAST);
			assert.equal(c.outlined, below, `${name}: group ${g} ${c.colour}`);
			// Past the six chart colours every group's hue is moved until it clears 3:1 by itself.
			if (g >= CHART_COLOR_VARS.length) assert.equal(below, false, `${name}: group ${g} ${c.colour}`);
		}
	}
});

test('the document-detail modes (ingest date, file size, health, ingest node, table chunks) draw only ramp steps, chart or hashed colours, each clearing 3:1 or outlined', () => {
	const sample = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'provisional', 'sample_demo_1000_clusters.json'), 'utf8')) as ISampleResult;
	const rows = new Map<string, IDocumentItem>(
		sample.docs.map((doc, d) => [doc.objectId, { objectId: doc.objectId, path: doc.path, chunks: doc.chunks, has_first_chunk: d % 5 !== 0, tables: 0, deleted: false, nodeId: `node_${d % 12}`, size: 500 * (d + 1), modifyTime: null, ingestedAt: `2026-10-0${1 + (d % 2)}T10:00:00Z`, pointId: null, max_chunk_id: d % 7 === 0 ? (doc.chunks ?? 1) + 3 : (doc.chunks ?? 1) - 1, deleted_chunks: d % 9 === 0 ? 1 : 0 }]),
	);
	for (const { name, tokens } of themes) {
		const palette = readPalette((t) => tokens[t] ?? '');
		for (const mode of ['ingest-date', 'file-size', 'health', 'ingest-node', 'table'] as const) {
			const out = colourPoints(sample, mode, palette, { docRows: rows });
			assert.equal(out.note, null, `${name} ${mode}`);
			for (let i = 0; i < sample.n; i += 1) {
				const below = MAP_SURFACES.some((s) => ratio(tokens, out.colours[i] as string, s) < MIN_GRAPHIC_CONTRAST);
				assert.equal(out.outlined[i], below ? 1 : 0, `${name} ${mode}: point ${i} ${out.colours[i]}`);
			}
		}
	}
});
