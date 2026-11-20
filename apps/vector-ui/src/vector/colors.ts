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
// VECTOR - COLOURS AND CONTRAST (pure): which token the console draws with, and the arithmetic
// =============================================================================
//
// One place names the tokens the console draws with, so the components and
// tests/a11y.contrast.test.ts cannot drift apart. Measured in all six shipped
// themes (packages/shell/public/themes), against both surfaces the console
// sits on: every piece of TEXT is `--rr-text-primary` (7.40:1 at worst);
// `--rr-text-secondary` is 3.75:1 in RocketRide Dark and the status colours
// fall below 3:1 in the light themes, so neither ever colours text here. A
// chip's tone is a decorative edge; its label carries the whole message.
// The accent (focus ring, selected-row bar) is `--rr-border-focus`, at least
// 3:1 everywhere; `--rr-brand` is 1.85:1 in RocketRide Light and is not used.
// =============================================================================

/** All text the console writes. At least 4.5:1. */
export const CONSOLE_TEXT_TOKEN = '--rr-text-primary';

/** The focus ring and the selected-row bar. Graphics: at least 3:1. */
export const ACCENT_TOKEN = '--rr-border-focus';

/** Icons (the trash button draws in currentColor, which is the text token). Graphics: at least 3:1. */
export const ICON_TOKEN = '--rr-text-primary';

/** The backgrounds the console sits on. */
export const CONSOLE_SURFACES = ['--rr-bg-default', '--rr-bg-paper'] as const;

/** How much of the accent tints a selected row. */
export const SELECTED_TINT = 0.14;

/** WCAG 1.4.3: normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** WCAG 1.4.11: graphical objects and focus indicators. */
export const MIN_GRAPHIC_CONTRAST = 3;

/** The tone edge of each chip tone (decorative: the label carries the message). */
export const TONE_EDGE: Readonly<Record<'success' | 'info' | 'warning' | 'error' | 'muted', string>> = {
	success: 'var(--rr-color-success)',
	info: 'var(--rr-color-info)',
	warning: 'var(--rr-color-warning)',
	error: 'var(--rr-color-error)',
	muted: 'var(--rr-border-input)',
};

/**
 * The selected row's background.
 *
 * @returns A CSS colour: the accent mixed into the paper.
 */
export function selectedRowBackground(): string {
	return `color-mix(in srgb, var(${ACCENT_TOKEN}) ${Math.round(SELECTED_TINT * 100)}%, var(--rr-bg-paper))`;
}

/** An sRGB colour, 0-255 per channel. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/**
 * Parse `#rgb`, `#rrggbb` or `rgb()`/`rgba()` (alpha read separately by {@link opaqueOver}).
 *
 * @param text - A CSS colour.
 * @returns The colour, or null for anything else.
 */
export function parseColor(text: string): Rgb | null {
	const value = text.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
	if (hex) {
		const h =
			hex[1].length === 3
				? hex[1]
						.split('')
						.map((c) => c + c)
						.join('')
				: hex[1];
		return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
	}
	const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(value);
	if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
	return null;
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
 * WCAG contrast ratio.
 *
 * @param a - One colour.
 * @param b - The other.
 * @returns 1 to 21.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Mix a colour over an opaque background at an opacity.
 *
 * @param fg - The colour.
 * @param alpha - Its opacity 0-1.
 * @param bg - The background.
 * @returns The resulting opaque colour.
 */
export function tintOver(fg: Rgb, alpha: number, bg: Rgb): Rgb {
	const mix = (f: number, b: number): number => Math.round(f * alpha + b * (1 - alpha));
	return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

/**
 * The colour a CSS colour LOOKS like over an opaque background (its own alpha applied).
 *
 * @param text - A CSS colour, possibly rgba().
 * @param bg - The background.
 * @returns The opaque colour, or null when the text is not a colour this reads.
 */
export function opaqueOver(text: string, bg: Rgb): Rgb | null {
	const rgb = parseColor(text);
	if (rgb === null) return null;
	const alpha = /^rgba\([^)]*[\s,/]\s*(\d*\.?\d+)\s*\)$/.exec(text.trim().toLowerCase());
	return alpha ? tintOver(rgb, Number(alpha[1]), bg) : rgb;
}
