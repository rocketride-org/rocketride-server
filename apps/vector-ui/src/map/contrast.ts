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
// MAP - COLOUR PARSING AND CONTRAST (pure)
// =============================================================================
//
// The map draws in WebGL, which needs concrete RGB values, so every colour token
// is read as text (getComputedStyle, or a theme file in tests), parsed here, and
// measured with WCAG's contrast ratio against the surfaces the map sits on.
// =============================================================================

/** An sRGB colour, 0-255 per channel. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/**
 * Parse `#rgb`, `#rrggbb`, `rgb()`/`rgba()` or `hsl()`/`hsla()` (alpha read separately by {@link alphaOf}).
 *
 * @param text - A CSS colour.
 * @returns The colour, or null for anything else (a `var()`, a name).
 */
export function parseColor(text: string): Rgb | null {
	const value = String(text ?? '').trim().toLowerCase();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
	if (hex) {
		const h = (hex[1] as string).length === 3 ? (hex[1] as string).split('').map((c) => c + c).join('') : (hex[1] as string);
		return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
	}
	const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(value);
	if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
	const hsl = /^hsla?\(\s*(-?\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/.exec(value);
	if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
	return null;
}

/**
 * The alpha of an `rgba()`/`hsla()` colour.
 *
 * @param text - A CSS colour.
 * @returns 0-1 (1 when the colour has no alpha).
 */
export function alphaOf(text: string): number {
	const m = /^(?:rgba|hsla)\([^)]*?[,/]\s*(\d*(?:\.\d+)?)\s*\)$/.exec(String(text ?? '').trim().toLowerCase());
	if (!m || m[1] === '') return 1;
	const a = Number(m[1]);
	return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
}

/**
 * HSL to RGB.
 *
 * @param h - Hue, degrees.
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
 * @param color - sRGB.
 * @returns 0-1.
 */
export function relativeLuminance(color: Rgb): number {
	const channel = (v: number): number => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * WCAG contrast ratio.
 *
 * @param a - A colour.
 * @param b - Another.
 * @returns 1 to 21.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The opaque colour a (possibly translucent) colour shows over a background.
 *
 * @param text - A CSS colour.
 * @param bg - The opaque background.
 * @returns The composite, or null when `text` is not a colour.
 */
export function opaqueOver(text: string, bg: Rgb): Rgb | null {
	const fg = parseColor(text);
	if (fg === null) return null;
	const a = alphaOf(text);
	return { r: Math.round(fg.r * a + bg.r * (1 - a)), g: Math.round(fg.g * a + bg.g * (1 - a)), b: Math.round(fg.b * a + bg.b * (1 - a)) };
}

/**
 * CSS text of an opaque colour.
 *
 * @param color - sRGB.
 * @returns `rgb(r, g, b)`.
 */
export function toCss(color: Rgb): string {
	return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

/**
 * The lowest contrast of a colour against several backgrounds.
 *
 * @param color - The colour.
 * @param surfaces - Backgrounds.
 * @returns The minimum ratio.
 */
export function minContrast(color: Rgb, surfaces: readonly Rgb[]): number {
	return Math.min(...surfaces.map((s) => contrastRatio(color, s)));
}

/**
 * A stable 32-bit hash (FNV-1a over UTF-16 code units).
 *
 * @param text - Any text.
 * @returns A non-negative integer.
 */
export function stableHash(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}
