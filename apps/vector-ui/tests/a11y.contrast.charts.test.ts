// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONTRAST OF THE COLLECTION CHARTS: every chart token, both surfaces, all six shipped themes
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { contrastRatio, opaqueOver, parseColor } from '../src/map/contrast';
import type { Rgb } from '../src/map/contrast';
import { CHART_ACTIVE_TOKEN, CHART_AXIS_TOKEN, CHART_BAR_TOKEN, CHART_GRAPHIC_TOKENS, CHART_SKELETON_TOKEN, CHART_SURFACES, CHART_TEXT_TOKEN, CHART_TEXT_TOKENS } from '../src/vector/chartTokens';
import { MIN_GRAPHIC_CONTRAST, MIN_TEXT_CONTRAST } from '../src/vector/colors';

const THEME_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'shell', 'public', 'themes');
const themes = fs
	.readdirSync(THEME_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => ({ name: f.replace(/\.json$/, ''), tokens: JSON.parse(fs.readFileSync(path.join(THEME_DIR, f), 'utf8')) as Record<string, string> }));

/** Contrast of a token drawn over a surface token of a theme. */
function ratio(tokens: Record<string, string>, token: string, surface: string): number {
	const bg = parseColor(tokens[surface] as string) as Rgb;
	return contrastRatio(opaqueOver(tokens[token] as string, bg) as Rgb, bg);
}

/** The files that draw the charts. */
const CHART_FILES = ['components/StatsCharts.tsx', 'vector/chartTokens.ts'];

test('six shipped themes, each defining every chart token and surface', () => {
	assert.equal(themes.length, 6, themes.map((t) => t.name).join(', '));
	for (const { name, tokens } of themes) for (const t of [...CHART_GRAPHIC_TOKENS, ...CHART_TEXT_TOKENS, CHART_SKELETON_TOKEN, ...CHART_SURFACES]) assert.ok(tokens[t], `${name} lacks ${t}`);
});

test('bars, the selected bar and focus ring, and the baseline clear 3:1 on both surfaces in every theme', () => {
	const rows: string[] = [];
	for (const { name, tokens } of themes) {
		const cells = CHART_GRAPHIC_TOKENS.map((token) =>
			CHART_SURFACES.map((surface) => {
				const r = ratio(tokens, token, surface);
				assert.ok(r >= MIN_GRAPHIC_CONTRAST, `${name}: ${token} on ${surface} is ${r.toFixed(2)}:1 (< ${MIN_GRAPHIC_CONTRAST}:1)`);
				return r.toFixed(2);
			}).join('/')
		);
		rows.push(`${name} ${cells.join(' ')}`);
	}
	console.log(`chart graphics ${CHART_GRAPHIC_TOKENS.join(' ')} (bg-default/bg-paper):`, rows.join(' | '));
});

test('every word of the charts clears 4.5:1 on both surfaces in every theme', () => {
	for (const { name, tokens } of themes) for (const token of CHART_TEXT_TOKENS) for (const surface of CHART_SURFACES) assert.ok(ratio(tokens, token, surface) >= MIN_TEXT_CONTRAST, `${name}: ${token} on ${surface}`);
});

test('the selected bar is told apart from the others by more than colour: it is outlined (and the bar colours differ in every theme)', () => {
	assert.notEqual(CHART_BAR_TOKEN, CHART_ACTIVE_TOKEN);
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'StatsCharts.tsx'), 'utf8');
	assert.match(source, /stroke=\{selected \? `var\(\$\{CHART_TEXT_TOKEN\}\)` : 'none'\}/, 'the selected bar carries an outline in the text token');
	for (const { name, tokens } of themes) assert.notEqual(tokens[CHART_BAR_TOKEN], tokens[CHART_ACTIVE_TOKEN], name);
});

test('the chart files draw only with the measured tokens: no secondary text, no status colour, no brand colour, no literal colour', () => {
	for (const file of CHART_FILES) {
		const text = fs
			.readFileSync(path.resolve(__dirname, '..', 'src', file), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		assert.doesNotMatch(text, /--rr-text-secondary|--rr-text-disabled/, `${file}: secondary text fails in some theme`);
		assert.doesNotMatch(text, /--rr-color-(warning|error|success|info)/, `${file}: status colours fall below 3:1 in the light themes`);
		assert.doesNotMatch(text, /--rr-brand/, `${file}: the brand colour is 1.85:1 in RocketRide Light`);
		assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${file}: a literal colour bypasses the themes`);
	}
	assert.equal(CHART_AXIS_TOKEN, CHART_TEXT_TOKEN);
});
