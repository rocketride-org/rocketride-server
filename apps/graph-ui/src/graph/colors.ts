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
// GRAPH - LABEL COLOURS AND CONTRAST (pure)
// =============================================================================
//
// A label's colour must be the SAME every time that label is drawn, for the same
// schema. The rule:
//
//   - The connection's labels, sorted by code point, take the shell's six chart
//     colours in order (blue, green, yellow, purple, orange, red).
//   - Every further label, and any label not in the schema (the schema is a
//     snapshot), takes a colour from a stable hash of its name.
//   - Under a connection's style (graph/userData.ts, `labelColors`), a label
//     keeps the slot it was given when first seen, and a new label takes the
//     lowest slot still free (`nextAssignments`), so adding a label never moves
//     the colour of another. The slots come from the connection's whole schema
//     (the realm that owns it gives them), never from the labels one screen
//     passes, so every screen agrees; a label without a slot takes its hashed
//     colour. A person's own choice comes before both.
//
// Colour alone is never the only carrier of meaning: every node has an outline,
// carries its label in its spoken name and its inspector, and the legend names
// each colour. In the light themes the yellow and orange chart colours are
// below the 3:1 contrast WCAG asks of graphics against the page, so the outline
// is not decoration; the tests measure it against every shipped theme.
// =============================================================================

import type { IConnectionStyle } from './userData';

// =============================================================================
// TYPES AND TOKENS
// =============================================================================

/**
 * The shell's chart colour tokens, in assignment order. The order keeps the colours
 * that look alike apart: in the light themes yellow and orange are nearly the same
 * colour (measured in a real shell: #e67700 and #e67a2e) and blue and purple are close,
 * so yellow comes last and purple fifth: a connection with up to four labels never
 * shows a confusable pair, and one with more still has the label initial and the legend.
 */
export const CHART_COLOR_VARS = ['--rr-chart-blue', '--rr-chart-green', '--rr-chart-red', '--rr-chart-orange', '--rr-chart-purple', '--rr-chart-yellow'] as const;

/** The names of the chart colours, in the order of {@link CHART_COLOR_VARS} (what the style editor calls them). */
export const CHART_COLOR_NAMES = ['Blue', 'Green', 'Red', 'Orange', 'Purple', 'Yellow'] as const;

/**
 * The chart colours a relationship type may be drawn in: the slots whose colour is at least 3:1 against both canvas
 * surfaces in every shipped theme (tests/a11y.contrast.test.ts measures them). A relationship is a thin line with
 * no outline, so it cannot lean on one the way a node does; orange and yellow are below 3:1 in the light themes.
 */
export const TYPE_COLOR_SLOTS: readonly number[] = [0, 1, 2, 4];

/** One label's colour. */
export interface ILabelColor {
	label: string;
	/** A CSS colour: `var(--rr-chart-*)` for the first six labels, `hsl(...)` otherwise. */
	fill: string;
	/** Index into {@link CHART_COLOR_VARS}, or null for a hashed colour. */
	slot: number | null;
}

/** An sRGB colour, 0-255 per channel. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

// =============================================================================
// ASSIGNMENT
// =============================================================================

/**
 * A stable 32-bit hash of a name (FNV-1a over UTF-16 code units).
 *
 * @param name - Any text.
 * @returns A non-negative integer.
 */
export function stableHash(name: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * The hashed colour of a label.
 *
 * @param label - A label name.
 * @returns An `hsl()` colour with a fixed saturation and lightness, so only the hue varies.
 */
export function hashColor(label: string): string {
	const hue = stableHash(label) % 360;
	return `hsl(${hue}, 55%, 46%)`;
}

/**
 * Assign colours to a connection's labels.
 *
 * @param labels - Every label of the connection (any order, duplicates allowed).
 * @returns A colour per distinct label.
 */
export function assignLabelColors(labels: Iterable<string>): Map<string, ILabelColor> {
	const distinct = Array.from(new Set(labels)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const out = new Map<string, ILabelColor>();
	distinct.forEach((label, index) => {
		out.set(label, index < CHART_COLOR_VARS.length ? { label, fill: `var(${CHART_COLOR_VARS[index]})`, slot: index } : { label, fill: hashColor(label), slot: null });
	});
	return out;
}

/**
 * The colour slots to give labels seen for the first time: labels already in `assigned` keep theirs (they are not
 * returned), and the new ones, sorted by code point, take the lowest slots nobody holds. Once all six are held, a
 * further label gets no slot (it is drawn in its hashed colour), so no two assigned labels share a chart colour.
 *
 * @param assigned - The slots given so far (label to index into {@link CHART_COLOR_VARS}).
 * @param labels - The labels seen now (any order, duplicates allowed).
 * @returns Only the NEW entries (empty when nothing changes).
 */
export function nextAssignments(assigned: Readonly<Record<string, number>>, labels: Iterable<string>): Record<string, number> {
	const held = new Set<number>();
	for (const label of Object.keys(assigned)) held.add(assigned[label]);
	const fresh = Array.from(new Set(labels))
		.filter((label) => label !== '' && !Object.prototype.hasOwnProperty.call(assigned, label))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const out: Record<string, number> = {};
	let slot = 0;
	for (const label of fresh) {
		while (slot < CHART_COLOR_VARS.length && held.has(slot)) slot += 1;
		if (slot >= CHART_COLOR_VARS.length) break;
		// An own entry: a label may be named `__proto__`, and is just another key here.
		Object.defineProperty(out, label, { value: slot, enumerable: true, writable: true, configurable: true });
		held.add(slot);
	}
	return out;
}

/**
 * Whether a value is a chart colour slot.
 *
 * @param slot - Anything.
 * @returns True for an integer index into {@link CHART_COLOR_VARS}.
 */
function isSlot(slot: unknown): slot is number {
	return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < CHART_COLOR_VARS.length;
}

/**
 * The colours of a connection's labels under its style: the person's own slot first, then the slot the label was
 * given (style.assigned: by the realm that owns the schema, from the connection's whole label list, shown before it is
 * stored), else the label's hashed colour. Which labels a screen passes never changes the colour of any of them.
 * Draw labels in a neutral colour until the style is ready (graph/userData.ts IStyleView).
 *
 * @param style - The connection's style (graph/userData.ts).
 * @param labels - The labels to colour (any order, duplicates allowed).
 * @returns A colour per distinct label.
 */
export function labelColors(style: IConnectionStyle, labels: Iterable<string>): Map<string, ILabelColor> {
	const distinct = Array.from(new Set(labels)).filter((label) => label !== '');
	const out = new Map<string, ILabelColor>();
	for (const label of distinct.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
		const own = Object.prototype.hasOwnProperty.call(style.labels, label) ? style.labels[label]?.slot : undefined;
		const given = Object.prototype.hasOwnProperty.call(style.assigned, label) ? style.assigned[label] : undefined;
		const slot = isSlot(own) ? own : isSlot(given) ? given : null;
		out.set(label, slot === null ? { label, fill: hashColor(label), slot: null } : { label, fill: `var(${CHART_COLOR_VARS[slot]})`, slot });
	}
	return out;
}

/** The fill of a label whose style has not been read: lighter than the grey of an unlabelled node, so the two are told apart. */
export const NEUTRAL_LOADING_FILL = 'var(--rr-grey-200)';

/**
 * The colour of every label while the connection's style has not been read yet: one neutral grey, so nothing is drawn in
 * a colour that would change a moment later.
 *
 * @param labels - The labels (any order, duplicates allowed).
 * @returns A neutral colour per distinct label.
 */
export function neutralColors(labels: Iterable<string>): Map<string, ILabelColor> {
	const out = new Map<string, ILabelColor>();
	for (const label of labels) if (label !== '') out.set(label, { label, fill: NEUTRAL_LOADING_FILL, slot: null });
	return out;
}

/**
 * The colours a connection's style gives its relationship types. Only a type with a chosen colour from
 * {@link TYPE_COLOR_SLOTS} is listed; every other type keeps the ordinary line colour.
 *
 * @param style - The connection's style.
 * @returns A CSS colour per styled type.
 */
export function typeColorsOf(style: IConnectionStyle): Map<string, string> {
	const out = new Map<string, string>();
	for (const type of Object.keys(style.types)) {
		const slot = style.types[type]?.slot;
		if (typeof slot === 'number' && TYPE_COLOR_SLOTS.includes(slot)) out.set(type, `var(${CHART_COLOR_VARS[slot]})`);
	}
	return out;
}

/**
 * The colour for a label, falling back to its hash when the schema does not know it.
 *
 * @param colors - The assignment from {@link assignLabelColors}.
 * @param label - A label name (empty for an unlabelled node).
 * @returns The colour.
 */
export function colorFor(colors: ReadonlyMap<string, ILabelColor>, label: string | undefined): ILabelColor {
	if (label === undefined || label === '') return { label: '', fill: 'var(--rr-grey-400)', slot: null };
	return colors.get(label) ?? { label, fill: hashColor(label), slot: null };
}

// =============================================================================
// CONTRAST
// =============================================================================

/**
 * Parse `#rgb`, `#rrggbb`, `rgb()`/`rgba()` (alpha ignored) or `hsl()`.
 *
 * @param text - A CSS colour.
 * @returns The colour, or null when it is not one of those forms.
 */
export function parseColor(text: string): Rgb | null {
	const value = text.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
	if (hex) {
		const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
		return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
	}
	const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(value);
	if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
	const hsl = /^hsla?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/.exec(value);
	if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
	return null;
}

/**
 * Convert HSL to RGB.
 *
 * @param h - Hue in degrees.
 * @param s - Saturation 0-1.
 * @param l - Lightness 0-1.
 * @returns The colour.
 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = l - c / 2;
	return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
}

/**
 * WCAG relative luminance.
 *
 * @param color - An sRGB colour.
 * @returns Luminance 0-1.
 */
export function relativeLuminance(color: Rgb): number {
	const channel = (v: number): number => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * WCAG contrast ratio between two colours.
 *
 * @param a - One colour.
 * @param b - The other colour.
 * @returns A ratio from 1 to 21.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Alpha-composite a colour over an opaque background.
 *
 * @param fg - Foreground colour.
 * @param alpha - Foreground opacity 0-1.
 * @param bg - Opaque background.
 * @returns The resulting opaque colour.
 */
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
	const mix = (f: number, b: number): number => Math.round(f * alpha + b * (1 - alpha));
	return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

/**
 * Black or white, whichever reads better on a fill.
 *
 * @param fill - The fill colour.
 * @returns `#000000` or `#ffffff`.
 */
export function readableOn(fill: Rgb): '#000000' | '#ffffff' {
	return contrastRatio(fill, { r: 0, g: 0, b: 0 }) >= contrastRatio(fill, { r: 255, g: 255, b: 255 }) ? '#000000' : '#ffffff';
}
