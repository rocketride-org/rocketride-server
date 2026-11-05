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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EDITOR THEME - TOKEN COLOURS THAT READ ON THE EDITOR'S OWN BACKGROUND
// =============================================================================
//
// Monaco colours code with its built-in `vs` and `vs-dark` palettes, which were not chosen
// for this app's backgrounds: on RocketRide Light's paper (#e8e7e1) the label token (`:Person`,
// #008080) is 3.85:1, under the 4.5:1 that small text needs. This builds the editor's token
// rules from the theme actually in use: each Cypher token keeps Monaco's colour when that
// already clears 4.5:1 against the editor background, and is otherwise moved along its own
// lightness (same hue, same saturation) until it does. No colour is written per theme.
//
// Pure: it takes the palette mode and the background and returns rules, so a test can build the
// editor's colours for every shipped theme and measure them.
// =============================================================================

import { composite, contrastRatio, parseColor } from '../graph/colors';
import type { Rgb } from '../graph/colors';

/** Text contrast the editor's tokens must reach (WCAG 1.4.3). */
export const TOKEN_MIN_CONTRAST = 4.5;

/** A Monaco token rule. */
export interface ITokenRule {
	token: string;
	foreground: string;
}

/**
 * The Cypher token classes the editor draws and the colour Monaco's own `vs` / `vs-dark` give each.
 * (Tokens with no entry, such as identifiers and function names, use the editor's foreground colour.)
 */
export const CYPHER_TOKEN_BASES: ReadonlyArray<{ token: string; light: string; dark: string }> = [
	{ token: 'keyword', light: '0000FF', dark: '569CD6' },
	{ token: 'type', light: '008080', dark: '3DC9B0' },
	{ token: 'string', light: 'A31515', dark: 'CE9178' },
	{ token: 'number', light: '098658', dark: 'B5CEA8' },
	{ token: 'number.hex', light: '3030C0', dark: '5BB498' },
	{ token: 'comment', light: '008000', dark: '608B4E' },
	{ token: 'delimiter', light: '000000', dark: 'DCDCDC' },
	{ token: 'invalid', light: 'CD3131', dark: 'F44747' },
];

/**
 * A colour as `RRGGBB` (no `#`), the form Monaco's rules take.
 *
 * @param rgb - The colour.
 * @returns Six hex digits, upper case.
 */
export function toRuleHex(rgb: Rgb): string {
	const part = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
	return `${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`.toUpperCase();
}

/** RGB to hue (0..360), saturation and lightness (0..1). */
function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
	const [R, G, B] = [r / 255, g / 255, b / 255];
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
	return { h: h * 60, s, l };
}

/** HSL back to RGB. */
function fromHsl(h: number, s: number, l: number): Rgb {
	const k = (n: number): number => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

/**
 * The colour itself when it already reaches `minimum` against the background, otherwise the nearest
 * colour of the same hue and saturation that does (lightness moved away from the background).
 *
 * @param color - The colour.
 * @param background - The background it is drawn on.
 * @param minimum - The contrast to reach.
 * @returns The colour to use.
 */
export function ensureContrast(color: Rgb, background: Rgb, minimum: number = TOKEN_MIN_CONTRAST): Rgb {
	if (contrastRatio(color, background) >= minimum) return color;
	const { h, s, l } = toHsl(color);
	// Away from the background: lighter on a dark page, darker on a light one (whichever end reads best).
	const towardWhite = contrastRatio({ r: 255, g: 255, b: 255 }, background) > contrastRatio({ r: 0, g: 0, b: 0 }, background);
	let near = l;
	let far = towardWhite ? 1 : 0;
	if (contrastRatio(fromHsl(h, s, far), background) < minimum) return color;
	for (let i = 0; i < 24; i++) {
		const mid = (near + far) / 2;
		if (contrastRatio(fromHsl(h, s, mid), background) >= minimum) far = mid;
		else near = mid;
	}
	return fromHsl(h, s, far);
}

/**
 * The editor's token rules for a palette and background: a rule only for a token whose Monaco colour fails.
 *
 * @param dark - Whether the palette is dark (Monaco's `vs-dark` base).
 * @param background - The editor's background, as a CSS colour.
 * @returns Rules for the failing tokens (empty when every colour already reads).
 */
export function cypherTokenRules(dark: boolean, background: string): ITokenRule[] {
	const bg = parseColor(background);
	if (!bg) return [];
	const rules: ITokenRule[] = [];
	for (const { token, light, dark: darkBase } of CYPHER_TOKEN_BASES) {
		const base = parseColor(`#${dark ? darkBase : light}`) as Rgb;
		const adjusted = ensureContrast(base, bg);
		if (adjusted !== base) rules.push({ token, foreground: toRuleHex(adjusted) });
	}
	return rules;
}

/**
 * A CSS colour as an opaque colour over a background (a `rgba()` token is blended, which is how it is seen).
 *
 * @param color - A CSS colour such as `rgba(10,10,10,0.62)` or `#0a0a0a`.
 * @param background - What it is drawn on.
 * @returns The colour as seen, or null when it cannot be read.
 */
export function opaqueOver(color: string, background: Rgb): Rgb | null {
	const rgb = parseColor(color);
	if (!rgb) return null;
	const alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/i.exec(color);
	return alpha ? composite(rgb, Number(alpha[1]), background) : rgb;
}

/**
 * A CSS colour as `#RRGGBB`, blended over a background when it has transparency.
 *
 * Monaco's theme colours must be hex: it reads `rgba(...)` as red, which once drew the line numbers
 * of RocketRide Light (whose secondary text colour is `rgba(10,10,10,0.62)`) in pure red.
 *
 * @param color - Any colour the app's own parser reads (`#abc`, `#aabbcc`, `rgb()`, `rgba()`, `hsl()`).
 * @param over - What it is drawn on; used for the blend.
 * @param fallback - Returned (as it is) when the colour cannot be read. Must itself be `#RRGGBB`.
 * @returns `#RRGGBB`, or the fallback.
 */
export function toHexColor(color: string, over: Rgb, fallback: string): string {
	const seen = opaqueOver(color, over);
	return seen ? `#${toRuleHex(seen)}` : fallback;
}

/**
 * A text colour for the editor, as `#RRGGBB`: the theme's own colour (blended over the background when it is
 * transparent) when that already reads, else the nearest colour of the same hue that does.
 *
 * @param color - The theme's CSS colour.
 * @param background - The editor's background, as a CSS colour.
 * @param fallback - Used when the colour cannot be read (held to the same contrast); returned as it is when the background cannot be read. Must itself be `#RRGGBB`.
 * @returns `#RRGGBB`.
 */
export function readableOnEditor(color: string, background: string, fallback: string = '#666666'): string {
	const bg = parseColor(background);
	if (!bg) return fallback;
	// An unreadable colour is replaced by the fallback, which is held to the same contrast.
	const seen = opaqueOver(color, bg) ?? parseColor(fallback);
	if (!seen) return fallback;
	return `#${toRuleHex(contrastRatio(seen, bg) >= TOKEN_MIN_CONTRAST ? seen : ensureContrast(seen, bg))}`;
}

/** What the editor theme is built from: the shell's tokens, as CSS strings (empty when unset). */
export interface IEditorColorInputs {
	/** Whether the palette is dark (picks the fallbacks). */
	dark: boolean;
	/** `--rr-bg-paper`. */
	background: string;
	/** `--rr-text-primary`. */
	foreground: string;
	/** `--rr-text-secondary`. */
	secondary: string;
}

/**
 * The `colors` of the editor theme: every value `#RRGGBB` (Monaco cannot read `rgba()`), the text colours at
 * least 4.5:1 on the editor background, and the existing defaults wherever a token is missing or unreadable.
 *
 * @param inputs - The shell's tokens.
 * @returns Monaco theme colours.
 */
export function editorColors({ dark, background, foreground, secondary }: IEditorColorInputs): Record<string, string> {
	const backgroundFallback = dark ? '#252526' : '#ffffff';
	const foregroundFallback = dark ? '#cccccc' : '#1a1a1a';
	const page = parseColor(background) ?? (parseColor(backgroundFallback) as Rgb);
	const bg = toHexColor(background, page, backgroundFallback);
	const text = readableOnEditor(foreground, bg, foregroundFallback);
	return {
		'editor.background': bg,
		'editor.foreground': text,
		// Line numbers are small text too: the shell's secondary colour, as it looks over the editor, moved to 4.5:1 only where it falls short.
		'editorLineNumber.foreground': readableOnEditor(secondary, bg, '#666666'),
		'editorLineNumber.activeForeground': text,
	};
}
