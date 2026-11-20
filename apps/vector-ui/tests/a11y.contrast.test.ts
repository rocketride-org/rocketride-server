// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// A11Y CONTRAST: every colour the console draws with, measured in all six shipped themes
// =============================================================================
//
// WCAG 2.x ratios against the EFFECTIVE background:
//   - text (figures, rows, chips, footers, the drawer): at least 4.5:1 (1.4.3)
//   - graphics (the focus ring, the selected-row bar, the trash icon): at least 3:1 (1.4.11)
// against both surfaces the console sits on (--rr-bg-default, --rr-bg-paper),
// and for the selected row against its tinted background. The tokens are the
// constants the components draw with (vector/colors.ts); the findings are in
// docs/contrast.md.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ACCENT_TOKEN, CONSOLE_SURFACES, CONSOLE_TEXT_TOKEN, ICON_TOKEN, MIN_GRAPHIC_CONTRAST, MIN_TEXT_CONTRAST, SELECTED_TINT, contrastRatio, opaqueOver, parseColor, selectedRowBackground, tintOver } from '../src/vector/colors';
import type { Rgb } from '../src/vector/colors';

const THEME_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'shell', 'public', 'themes');
const themes = fs
	.readdirSync(THEME_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => ({ name: f.replace(/\.json$/, ''), tokens: JSON.parse(fs.readFileSync(path.join(THEME_DIR, f), 'utf8')) as Record<string, string> }));

/** The ratio of one token drawn over one opaque background. */
function ratioOver(tokens: Record<string, string>, token: string, bg: Rgb): number {
	return contrastRatio(opaqueOver(tokens[token], bg) as Rgb, bg);
}

/** The ratio of one token over one surface of a theme. */
function ratio(tokens: Record<string, string>, token: string, surface: string): number {
	return ratioOver(tokens, token, parseColor(tokens[surface]) as Rgb);
}

/** The files the console's own lane draws (the map's and the chat/ingest components are measured by their lanes). */
const CONSOLE_FILES = ['components/StatsStrip.tsx', 'components/DocumentDirectory.tsx', 'components/DocumentRow.tsx', 'components/ChunkList.tsx', 'components/RemoveConfirmDialog.tsx', 'components/MultiRemoveConfirmDialog.tsx', 'components/ConnectionDrawerDetails.tsx', 'components/SupportBadge.tsx', 'views/ConnectionsView.tsx', 'views/ConsoleView.tsx', 'views/DocumentView.tsx', 'styles.ts'];

test('there are six shipped themes and each defines every token measured here', () => {
	assert.equal(themes.length, 6, themes.map((t) => t.name).join(', '));
	for (const { name, tokens } of themes) for (const t of [CONSOLE_TEXT_TOKEN, ACCENT_TOKEN, ICON_TOKEN, ...CONSOLE_SURFACES]) assert.ok(tokens[t], `${name} lacks ${t}`);
});

test("text: the console's one text token is at least 4.5:1 on both surfaces in every theme", () => {
	const rows: string[] = [];
	for (const { name, tokens } of themes) {
		const cells = CONSOLE_SURFACES.map((surface) => {
			const r = ratio(tokens, CONSOLE_TEXT_TOKEN, surface);
			assert.ok(r >= MIN_TEXT_CONTRAST, `${name}: ${CONSOLE_TEXT_TOKEN} on ${surface} is ${r.toFixed(2)}:1`);
			return r.toFixed(2);
		});
		rows.push(`${name} ${cells.join('/')}`);
	}
	console.log(`text ${CONSOLE_TEXT_TOKEN} (bg-default/bg-paper):`, rows.join(' | '));
});

test('graphics: the focus ring and the selected-row bar (the accent) and the trash icon are at least 3:1 in every theme', () => {
	for (const { name, tokens } of themes) {
		for (const surface of CONSOLE_SURFACES) {
			assert.ok(ratio(tokens, ACCENT_TOKEN, surface) >= MIN_GRAPHIC_CONTRAST, `${name}: accent on ${surface} is ${ratio(tokens, ACCENT_TOKEN, surface).toFixed(2)}:1`);
			assert.ok(ratio(tokens, ICON_TOKEN, surface) >= MIN_GRAPHIC_CONTRAST, `${name}: icon on ${surface}`);
		}
	}
});

test('the selected row: text stays at least 4.5:1 on its tinted background, and its bar at least 3:1 against the page', () => {
	assert.equal(selectedRowBackground(), `color-mix(in srgb, var(${ACCENT_TOKEN}) ${Math.round(SELECTED_TINT * 100)}%, var(--rr-bg-paper))`);
	for (const { name, tokens } of themes) {
		const paper = parseColor(tokens['--rr-bg-paper']) as Rgb;
		const tinted = tintOver(opaqueOver(tokens[ACCENT_TOKEN], paper) as Rgb, SELECTED_TINT, paper);
		const text = ratioOver(tokens, CONSOLE_TEXT_TOKEN, tinted);
		assert.ok(text >= MIN_TEXT_CONTRAST, `${name}: selected-row text is ${text.toFixed(2)}:1`);
		// The bar is the row's outer edge, so the colour next to it is the page.
		assert.ok(ratioOver(tokens, ACCENT_TOKEN, paper) >= MIN_GRAPHIC_CONTRAST, `${name}: the selected-row bar against the page`);
	}
});

test('the secondary and disabled text tokens fail in some theme, which is why the console never writes text in them', () => {
	const dark = themes.find((t) => t.name === 'rocketride')!;
	assert.ok(Math.min(...CONSOLE_SURFACES.map((s) => ratio(dark.tokens, '--rr-text-secondary', s))) < MIN_TEXT_CONTRAST, 'the premise');
	for (const file of CONSOLE_FILES) {
		const full = path.resolve(__dirname, '..', 'src', file);
		assert.ok(fs.existsSync(full), `${file} exists`);
		const text = fs
			.readFileSync(full, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		assert.doesNotMatch(text, /--rr-text-secondary|--rr-text-disabled/, `${file} writes text in a token that fails in some theme`);
		assert.doesNotMatch(text, /var\(--rr-brand\)|'--rr-brand'/, `${file} draws with the brand colour (1.85:1 in RocketRide Light)`);
		assert.doesNotMatch(text, /color: 'var\(--rr-color-(warning|error|success|info)\)'/, `${file} writes text in a status colour (below 3:1 in the light themes)`);
	}
});

test('parseColor and the contrast arithmetic', () => {
	assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
	assert.deepEqual(parseColor('rgba(10, 10, 10, 0.62)'), { r: 10, g: 10, b: 10 });
	assert.equal(parseColor('var(--x)'), null);
	assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }).toFixed(1), '21.0');
	assert.deepEqual(opaqueOver('rgba(255,255,255,0.5)', { r: 0, g: 0, b: 0 }), { r: 128, g: 128, b: 128 });
	assert.equal(opaqueOver('nonsense', { r: 0, g: 0, b: 0 }), null);
	assert.deepEqual(tintOver({ r: 255, g: 0, b: 0 }, 0.5, { r: 0, g: 0, b: 255 }), { r: 128, g: 0, b: 128 });
});
