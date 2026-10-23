// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// A11Y CONTRAST: every colour the canvas, the inspector and the editor draw with,
// measured against every shipped theme
// =============================================================================
//
// WCAG 2.x ratios, computed against the EFFECTIVE background:
//   - graphics (the highlight stroke, the selection ring, the focus ring, ordinary relationship
//     lines): at least 3:1 (1.4.11)
//   - small text (relationship labels, the inspector's label pills, the editor's tokens): at least
//     4.5:1 (1.4.3)
// against both backgrounds the canvas and its panels sit on, in all six themes in
// packages/shell/public/themes. The pairs are the constants the code draws with (canvas/tokens.ts),
// so changing a colour in the code changes what is measured here.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ACCENT_TOKEN, CANVAS_SURFACES, CANVAS_TEXT_TOKEN, CHIP_TEXT_TOKEN, EDGE_TOKEN, MIN_GRAPHIC_CONTRAST, MIN_TEXT_CONTRAST } from '../src/canvas/tokens';
import { CANVAS_RULES } from '../src/canvas/environment';
import { CYPHER_TOKEN_BASES, cypherTokenRules, editorColors, ensureContrast, opaqueOver, readableOnEditor, toHexColor, toRuleHex } from '../src/components/editorTheme';
import { contrastRatio, parseColor } from '../src/graph/colors';
import type { Rgb } from '../src/graph/colors';

const THEME_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'shell', 'public', 'themes');
const themes = fs
	.readdirSync(THEME_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => ({ name: f.replace(/\.json$/, ''), tokens: JSON.parse(fs.readFileSync(path.join(THEME_DIR, f), 'utf8')) as Record<string, string> }));

/** The ratio of one token drawn over one surface of a theme. */
function ratio(tokens: Record<string, string>, token: string, surface: string): number {
	const bg = parseColor(tokens[surface]) as Rgb;
	return contrastRatio(opaqueOver(tokens[token], bg) as Rgb, bg);
}

/** Assert a token clears a minimum over every canvas surface of every theme; returns the table for the report. */
function clears(token: string, minimum: number, what: string): string[] {
	const rows: string[] = [];
	for (const { name, tokens } of themes) {
		const cells = CANVAS_SURFACES.map((surface) => {
			const r = ratio(tokens, token, surface);
			assert.ok(r >= minimum, `${what}: ${token} on ${surface} in ${name} is ${r.toFixed(2)}:1, under ${minimum}:1`);
			return r.toFixed(2);
		});
		rows.push(`${name} ${cells.join('/')}`);
	}
	return rows;
}

test('there are six shipped themes and each defines every token measured here', () => {
	assert.equal(themes.length, 6, themes.map((t) => t.name).join(', '));
	for (const { name, tokens } of themes) for (const t of [ACCENT_TOKEN, EDGE_TOKEN, CANVAS_TEXT_TOKEN, CHIP_TEXT_TOKEN, ...CANVAS_SURFACES, '--rr-palette-mode']) assert.ok(tokens[t], `${name} lacks ${t}`);
});

test('the highlight stroke, the selection ring and the focus ring (the accent) are at least 3:1 on both canvas surfaces in every theme', () => {
	const table = clears(ACCENT_TOKEN, MIN_GRAPHIC_CONTRAST, 'accent');
	console.log(`accent ${ACCENT_TOKEN} (bg-default/bg-paper):`, table.join(' | '));
});

test('the old accent, the brand colour, is measured here and fails 3:1 in RocketRide Light (the reason it was replaced)', () => {
	const light = themes.find((t) => t.name === 'rocketride-light')!;
	const r = CANVAS_SURFACES.map((s) => ratio(light.tokens, '--rr-brand', s));
	console.log('brand on rocketride-light (bg-default/bg-paper):', r.map((x) => x.toFixed(2)).join('/'));
	assert.ok(Math.max(...r) < MIN_GRAPHIC_CONTRAST, 'if this ever passes, the replacement is no longer needed');
	assert.notEqual(ACCENT_TOKEN, '--rr-brand');
});

test('a highlighted relationship is told apart from an ordinary one by more than its colour: a different token AND a thicker line', () => {
	assert.notEqual(ACCENT_TOKEN, EDGE_TOKEN);
	const layer = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'canvas', 'EdgeLayer.tsx'), 'utf8');
	assert.match(layer, /strokeWidth=\{highlighted \? 2 : 1\.4\}/);
	assert.match(layer, /highlighted \? `var\(\$\{ACCENT_TOKEN\}\)` : `var\(\$\{EDGE_TOKEN\}\)`/);
});

test('an ordinary relationship line is at least 3:1 on both canvas surfaces in every theme', () => {
	clears(EDGE_TOKEN, MIN_GRAPHIC_CONTRAST, 'relationship line');
});

test('relationship type labels (10 px text) are at least 4.5:1 on both canvas surfaces in every theme', () => {
	const table = clears(CANVAS_TEXT_TOKEN, MIN_TEXT_CONTRAST, 'edge label');
	console.log(`edge label ${CANVAS_TEXT_TOKEN} (bg-default/bg-paper):`, table.join(' | '));
	const dark = themes.find((t) => t.name === 'rocketride')!;
	console.log('previous label colour --rr-text-secondary on rocketride (bg-default/bg-paper):', CANVAS_SURFACES.map((s) => ratio(dark.tokens, '--rr-text-secondary', s).toFixed(2)).join('/'));
	assert.ok(Math.min(...CANVAS_SURFACES.map((s) => ratio(dark.tokens, '--rr-text-secondary', s))) < MIN_TEXT_CONTRAST, 'the secondary colour fails in RocketRide Dark: that is why labels do not use it');
});

test('the inspector\'s label pill text is at least 4.5:1 on both surfaces in every theme (the shell chip\'s info colour was 3.46:1 in RocketRide Light)', () => {
	clears(CHIP_TEXT_TOKEN, MIN_TEXT_CONTRAST, 'label pill');
	const light = themes.find((t) => t.name === 'rocketride-light')!;
	const info = ratio(light.tokens, '--rr-color-info', '--rr-bg-default');
	console.log('previous pill text --rr-color-info on rocketride-light bg-default:', info.toFixed(2));
	assert.ok(info < MIN_TEXT_CONTRAST);
	const panel = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'InspectorPanel.tsx'), 'utf8');
	assert.doesNotMatch(panel, /\bChip\b.*from 'shell'/, 'the shell chip is not used for labels');
	assert.match(panel, /color: `var\(\$\{CHIP_TEXT_TOKEN\}\)`/);
});

test('the stylesheet draws the ring, the focus outline and the labels with the measured tokens, and never with the brand colour', () => {
	assert.ok(CANVAS_RULES.includes(`box-shadow: 0 0 0 3px var(${ACCENT_TOKEN})`));
	assert.ok(CANVAS_RULES.includes(`outline: 3px solid var(${ACCENT_TOKEN},`));
	assert.ok(CANVAS_RULES.includes(`fill: var(${CANVAS_TEXT_TOKEN})`));
	for (const dir of ['canvas', 'components', 'views']) {
		for (const file of fs.readdirSync(path.resolve(__dirname, '..', 'src', dir))) {
			const text = fs.readFileSync(path.resolve(__dirname, '..', 'src', dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			assert.doesNotMatch(text, /var\(--rr-brand\)|'--rr-brand'/, `${dir}/${file} draws with the brand colour`);
		}
	}
});

// -----------------------------------------------------------------------------
// The editor's token colours
// -----------------------------------------------------------------------------

/** The colour the editor ends up drawing a token in, for a theme: the rule when there is one, else Monaco's own. */
function editorColour(theme: { tokens: Record<string, string> }, token: string): Rgb {
	const dark = theme.tokens['--rr-palette-mode'] === 'dark';
	const rules = cypherTokenRules(dark, theme.tokens['--rr-bg-paper']);
	const rule = rules.find((r) => r.token === token);
	const base = CYPHER_TOKEN_BASES.find((b) => b.token === token)!;
	return parseColor(`#${rule ? rule.foreground : dark ? base.dark : base.light}`) as Rgb;
}

test('every Cypher token the editor colours is at least 4.5:1 on the editor background (the paper) in every theme', () => {
	const worstBefore: string[] = [];
	for (const theme of themes) {
		const paper = parseColor(theme.tokens['--rr-bg-paper']) as Rgb;
		const dark = theme.tokens['--rr-palette-mode'] === 'dark';
		for (const { token, light, dark: darkBase } of CYPHER_TOKEN_BASES) {
			const before = contrastRatio(parseColor(`#${dark ? darkBase : light}`) as Rgb, paper);
			const after = contrastRatio(editorColour(theme, token), paper);
			if (before < MIN_TEXT_CONTRAST) worstBefore.push(`${theme.name} ${token} ${before.toFixed(2)} -> ${after.toFixed(2)}`);
			assert.ok(after >= MIN_TEXT_CONTRAST, `${theme.name}: token ${token} is ${after.toFixed(2)}:1 on the editor`);
		}
	}
	console.log('editor tokens that failed 4.5:1 with Monaco\'s own colours (before -> after):', worstBefore.join(' | '));
	assert.ok(worstBefore.length > 0, 'the measurement found failures to fix: the label token on RocketRide Light is one');
});

test('the label token (type, ":Person") on RocketRide Light was 3.85:1 and is now at least 4.5:1, and keeps its teal hue', () => {
	const light = themes.find((t) => t.name === 'rocketride-light')!;
	const paper = parseColor(light.tokens['--rr-bg-paper']) as Rgb;
	assert.ok(Math.abs(contrastRatio(parseColor('#008080') as Rgb, paper) - 3.85) < 0.05);
	const rules = cypherTokenRules(false, light.tokens['--rr-bg-paper']);
	const type = rules.find((r) => r.token === 'type');
	assert.ok(type, 'a rule exists for the failing token');
	const rgb = parseColor(`#${type.foreground}`) as Rgb;
	assert.ok(contrastRatio(rgb, paper) >= MIN_TEXT_CONTRAST);
	assert.ok(rgb.g > rgb.r && Math.abs(rgb.g - rgb.b) <= 4, `still teal: ${type.foreground}`);
});

test('only tokens whose Monaco colour fails get a rule: on a white page nothing needs changing for the light palette except what fails', () => {
	const white = '#ffffff';
	const rules = cypherTokenRules(false, white);
	for (const { token, light } of CYPHER_TOKEN_BASES) {
		const fails = contrastRatio(parseColor(`#${light}`) as Rgb, parseColor(white) as Rgb) < MIN_TEXT_CONTRAST;
		assert.equal(rules.some((r) => r.token === token), fails, `${token}: rule present iff its colour fails on white`);
	}
	assert.deepEqual(cypherTokenRules(false, 'not a colour'), []);
});

test('ensureContrast leaves a passing colour untouched, moves a failing one along its lightness only, and gives up rather than loop when nothing can work', () => {
	const black = parseColor('#000000') as Rgb;
	const white = parseColor('#ffffff') as Rgb;
	const passing = parseColor('#0000ff') as Rgb;
	assert.equal(ensureContrast(passing, white), passing, 'the very same object');
	const teal = parseColor('#008080') as Rgb;
	const paper = parseColor('#e8e7e1') as Rgb;
	const fixed = ensureContrast(teal, paper);
	assert.ok(contrastRatio(fixed, paper) >= 4.5 && contrastRatio(fixed, paper) < 5.5, 'close to the target, not pushed to black');
	assert.ok(contrastRatio(ensureContrast(parseColor('#3030c0') as Rgb, black), black) >= 4.5, 'on a black page it is made lighter');
	// No colour reaches 10:1 on a mid grey: it is returned as it is rather than searched for.
	const mid = parseColor('#808080') as Rgb;
	const stuck = parseColor('#404040') as Rgb;
	assert.equal(ensureContrast(stuck, mid, 10), stuck);
	assert.equal(toRuleHex({ r: 0, g: 128, b: 255 }), '0080FF');
});

const HEX = /^#[0-9a-f]{6}$/i;

/** The editor theme colours for a shipped theme, built the way the editor builds them. */
function colorsOf(theme: { tokens: Record<string, string> }): Record<string, string> {
	return editorColors({ dark: theme.tokens['--rr-palette-mode'] === 'dark', background: theme.tokens['--rr-bg-paper'], foreground: theme.tokens['--rr-text-primary'], secondary: theme.tokens['--rr-text-secondary'] });
}

test('every value of the editor theme is #RRGGBB in every shipped theme (Monaco reads rgba() as red), and the text colours are at least 4.5:1 on the editor background', () => {
	for (const theme of themes) {
		const colors = colorsOf(theme);
		const paper = parseColor(colors['editor.background']) as Rgb;
		for (const [key, value] of Object.entries(colors)) assert.match(value, HEX, `${theme.name}: ${key} is "${value}", not #RRGGBB`);
		for (const key of ['editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground']) {
			const r = contrastRatio(parseColor(colors[key]) as Rgb, paper);
			assert.ok(r >= MIN_TEXT_CONTRAST, `${theme.name}: ${key} is ${r.toFixed(2)}:1 on the editor`);
		}
		// The editor background is the theme's paper itself.
		assert.equal(colors['editor.background'].toLowerCase(), `#${toRuleHex(paper)}`.toLowerCase());
		assert.equal(paper.r, (parseColor(theme.tokens['--rr-bg-paper']) as Rgb).r);
	}
});

test('RocketRide Light\'s secondary text is rgba(10,10,10,0.62): the line numbers get the colour it LOOKS like over the paper, as hex, not the rgba string', () => {
	const light = themes.find((t) => t.name === 'rocketride-light')!;
	assert.match(light.tokens['--rr-text-secondary'], /^rgba\(/, 'the premise: this theme\'s token is an rgba()');
	const out = readableOnEditor(light.tokens['--rr-text-secondary'], light.tokens['--rr-bg-paper']);
	assert.match(out, HEX);
	const paper = parseColor(light.tokens['--rr-bg-paper']) as Rgb;
	assert.equal(out.toLowerCase(), `#${toRuleHex(opaqueOver(light.tokens['--rr-text-secondary'], paper) as Rgb)}`.toLowerCase(), 'already readable: the blended colour, unadjusted');
});

test('line numbers: a theme colour that already reads is kept as it LOOKS (blended, as hex), and one that does not is moved to 4.5:1 only (RocketRide Dark)', () => {
	for (const theme of themes) {
		const bg = theme.tokens['--rr-bg-paper'];
		const out = readableOnEditor(theme.tokens['--rr-text-secondary'], bg);
		assert.match(out, HEX, `${theme.name}: ${out}`);
		const paper = parseColor(bg) as Rgb;
		assert.ok(contrastRatio(parseColor(out) as Rgb, paper) >= MIN_TEXT_CONTRAST, `${theme.name}: line numbers are ${contrastRatio(parseColor(out) as Rgb, paper).toFixed(2)}:1`);
		const original = opaqueOver(theme.tokens['--rr-text-secondary'], paper) as Rgb;
		if (contrastRatio(original, paper) >= MIN_TEXT_CONTRAST) assert.equal(out.toLowerCase(), `#${toRuleHex(original)}`.toLowerCase(), `${theme.name}: an already-readable colour is kept (as hex)`);
	}
	// RocketRide Dark (rgba white at 40%) is the one that has to move.
	const dark = themes.find((t) => t.name === 'rocketride')!;
	const original = opaqueOver(dark.tokens['--rr-text-secondary'], parseColor(dark.tokens['--rr-bg-paper']) as Rgb) as Rgb;
	assert.ok(contrastRatio(original, parseColor(dark.tokens['--rr-bg-paper']) as Rgb) < MIN_TEXT_CONTRAST);
	assert.notEqual(readableOnEditor(dark.tokens['--rr-text-secondary'], dark.tokens['--rr-bg-paper']).toLowerCase(), `#${toRuleHex(original)}`.toLowerCase());
});

test('a missing or unreadable token falls back to the existing defaults, still as hex', () => {
	for (const dark of [false, true]) {
		const colors = editorColors({ dark, background: '', foreground: '', secondary: '' });
		for (const value of Object.values(colors)) assert.match(value, HEX);
		assert.equal(colors['editor.background'].toLowerCase(), dark ? '#252526' : '#ffffff');
		assert.equal(colors['editor.foreground'].toLowerCase(), dark ? '#cccccc' : '#1a1a1a');
		assert.ok(contrastRatio(parseColor(colors['editorLineNumber.foreground']) as Rgb, parseColor(colors['editor.background']) as Rgb) >= MIN_TEXT_CONTRAST);
	}
	assert.equal(toHexColor('var(--x)', { r: 0, g: 0, b: 0 }, '#123456'), '#123456');
	assert.equal(toHexColor('rgba(255,255,255,0.5)', { r: 0, g: 0, b: 0 }, '#123456'), '#808080');
	assert.equal(readableOnEditor('nonsense', '#ffffff').toLowerCase(), '#666666');
	assert.equal(readableOnEditor('#000000', 'nonsense', '#abcdef'), '#abcdef');
});

// The editor mounts the platform's shared MonacoEditor ('shared/components/monaco'). That component defines and
// FORCES its own theme ('rr-theme', with no token rules) when it creates the editor and again on every theme flip,
// so an app-local theme cannot persist. The Cypher token rules and the line-number colour measured above are still
// computed and tested, but the editor does not apply them until the shared editor takes per-app token colours
// (drafted platform ask: explorer-devtool ROD_ASKS #7). Until then the editor shows Monaco's own vs / vs-dark token
// colours, including the ones listed as failing in the output of the token test above. These pins describe the
// seam as it is, so a change on either side is a decision rather than drift.
test('wiring: the editor is the shared MonacoEditor, with no @monaco-editor package and no theme of its own (token colours: ROD_ASKS #7)', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'QueryEditor.tsx'), 'utf8');
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	assert.match(code, /import \{ MonacoEditor, loadMonaco \} from 'shared\/components\/monaco';/, 'the shared editor and its one loader');
	const at = code.indexOf('<MonacoEditor');
	assert.ok(at >= 0, 'the editor renders <MonacoEditor');
	assert.match(code.slice(at, code.indexOf('/>', at)), /\blanguage="cypher"/, 'Monaco\'s built-in cypher language');
	assert.doesNotMatch(code, /@monaco-editor\//, 'the platform loader bans @monaco-editor/react and @monaco-editor/loader');
	assert.doesNotMatch(code, /defineTheme|setTheme|\btheme=|THEME_NAME|cypherTokenRules|editorColors/, 'no app-local theme: the shared editor forces its own');
	assert.doesNotMatch(code, /from '\.\/editorTheme'/, 'the measured rules are not wired into the editor (ROD_ASKS #7)');

	// The shared side of the seam. When the shared theme starts carrying token rules, or stops forcing its theme,
	// this fails: wire cypherTokenRules and the line-number colour back in, and update these pins.
	const shared = path.resolve(__dirname, '..', '..', 'shared', 'src', 'components', 'monaco');
	const theme = fs.readFileSync(path.join(shared, 'theme.ts'), 'utf8');
	const editor = fs.readFileSync(path.join(shared, 'MonacoEditor.tsx'), 'utf8');
	assert.match(theme, /rules: \[\],/, 'the shared theme has no token rules');
	assert.match(editor, /theme: THEME_NAME,/, 'the shared editor creates every editor with its own theme');
	assert.match(editor, /defineRrTheme\(monaco\);\s*monaco\.editor\.setTheme\(THEME_NAME\);/, 'and re-applies it on every theme flip');
});
