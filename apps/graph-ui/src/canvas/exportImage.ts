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
// CANVAS - IMAGE EXPORT (an SVG built from the layout, and PNG from that SVG)
// =============================================================================
//
// The page is not rasterised (no DOM-to-image library, nothing that depends on how React
// Flow nests its layers): the SVG is written from what the canvas already holds - each
// node's centre, radius, colour, badge and caption, and each relationship's slot, from
// which the same geometry the edge layer draws from (graph/geometry.ts) gives its line,
// arrow and label. The picture covers the WHOLE drawing (contentBounds, plus a margin),
// not just the part in view.
//
// The canvas draws with CSS variables (`var(--rr-chart-1)`), which mean nothing once the
// SVG leaves the page, so every colour goes through a resolver first, and a colour that
// still cannot be resolved is drawn in a plain grey rather than left out. The resolver
// asks the browser for the colour as an element inside the canvas would show it now (the
// current theme), and reads it back as plain #rrggbb: a token's own text can be another
// variable or a `color-mix()` an SVG viewer does not understand.
//
// The picture is self-contained: a background rectangle in the canvas colour (a dark
// theme's drawing on a transparent PNG would be unreadable), the system font stack (an SVG
// drawn as an image cannot load the page's web fonts), and no foreignObject (it taints the
// canvas in Safari, which then refuses to give the PNG back).
//
// PNG is that SVG drawn into a <canvas> at twice the size, as large as a browser canvas
// can hold. When there is no image, `exportResult` says why (too large, not ready, or the
// browser could not draw it), so the view never blames the size for something else.
// Drawing needs a browser; `buildSvg`, `pngScale` and `exportResult` do not, and are
// tested in Node.
// =============================================================================

import { edgeShape } from '../graph/geometry';
import type { IEdgeSlot } from '../graph/geometry';
import type { BadgeMode } from '../graph/userData';
import { contentBounds } from './fitBounds';

// =============================================================================
// TYPES
// =============================================================================

/** One node as exported. Colours may be CSS variables; they are resolved. */
export interface IExportNode {
	id: string;
	/** Centre, in canvas units. */
	x: number;
	y: number;
	radius: number;
	fill: string;
	/** The badge's colour (readable on the fill). */
	textColor: string;
	badge: string;
	badgeMode: BadgeMode;
	caption: string;
	dim: boolean;
	stale: boolean;
	selected: boolean;
}

/** One relationship as exported. */
export interface IExportEdge {
	id: string;
	source: string;
	target: string;
	slot: IEdgeSlot;
	type: string;
	stroke: string;
	width: number;
	dashed: boolean;
	dim: boolean;
}

/** The theme colours the drawing sits on and is written in. */
export interface IExportTheme {
	background: string;
	/** Captions and relationship labels. */
	text: string;
	/** The halo around text (the panel colour, as on the canvas). */
	halo: string;
	/** The outline of a node circle. */
	border: string;
	/** The selection ring. */
	accent: string;
}

/** How to write it. */
export interface IExportOptions {
	/** Turn any CSS colour (a `var(--x)` included) into one an SVG viewer understands. */
	resolve(css: string): string;
	/** Whether relationship type labels are written (the canvas hides them on a crowded graph). */
	labels: boolean;
	/** Margin around the drawing, in canvas units. */
	padding?: number;
}

// =============================================================================
// CONSTANTS AND HELPERS
// =============================================================================

/** The system font stack: an SVG opened elsewhere has none of the page's fonts. */
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** A caption is cut here, about the 150 px the canvas shows. */
const CAPTION_CHARS = 24;

/** Caption text size, and roughly how wide one character of it is. */
const CAPTION_SIZE = 11.5;
const CAPTION_CHAR = 6.4;

/** Drawn where a colour cannot be resolved. */
const FALLBACK_COLOUR = '#808080';

/** Opacity of what a path or a search leaves dimmed, and of an out-of-date node. */
const DIM_OPACITY = 0.2;
const STALE_OPACITY = 0.55;

/** The largest side and area a browser canvas reliably holds (the area is Safari's limit, the smallest; past it toBlob gives nothing or a blank image). */
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 16_777_216;

/**
 * A number for an attribute: two decimals, no trailing zeros.
 *
 * @param n - A finite number.
 * @returns Compact text.
 */
function fmt(n: number): string {
	const rounded = Math.round(n * 100) / 100;
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** What stands in for a character XML 1.0 cannot hold. */
const REPLACEMENT = '\ufffd';

/**
 * Text for XML content or an attribute value. Besides escaping, every character XML 1.0 cannot hold becomes U+FFFD:
 * a control character other than tab, line feed and carriage return, U+FFFE and U+FFFF, and half a surrogate pair. A
 * property value can hold any of them, and one would make the whole SVG unreadable (and the PNG drawn from it fail).
 *
 * @param text - Any text.
 * @returns The text, escaped and safe for XML.
 */
function escapeXml(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += text[i] + text[i + 1];
				i += 1;
			} else {
				out += REPLACEMENT;
			}
			continue;
		}
		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0xdc00 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
			out += REPLACEMENT;
			continue;
		}
		const ch = text[i];
		out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
	}
	return out;
}

/**
 * A caption as the export writes it: one line, cut with an ellipsis.
 *
 * @param caption - The caption the canvas shows.
 * @returns At most {@link CAPTION_CHARS} characters and the ellipsis.
 */
function cut(caption: string): string {
	const chars = [...caption];
	return chars.length > CAPTION_CHARS ? `${chars.slice(0, CAPTION_CHARS).join('')}…` : caption;
}

// =============================================================================
// SVG
// =============================================================================

/**
 * Write the drawing as a standalone SVG.
 *
 * @param nodes - The drawn nodes, with their centres.
 * @param edges - The drawn relationships (one with an end that is not among the nodes is left out, as on the canvas).
 * @param theme - Background, text, halo, outline and accent colours.
 * @param options - The colour resolver, whether labels are written, and the margin.
 * @returns The SVG text and its size in pixels, or null when nothing is drawn.
 */
export function buildSvg(nodes: readonly IExportNode[], edges: readonly IExportEdge[], theme: IExportTheme, options: IExportOptions): { svg: string; width: number; height: number } | null {
	if (nodes.length === 0) return null;
	const paint = (css: string): string => {
		const value = options.resolve(css).trim();
		return value === '' || value.includes('var(') ? FALLBACK_COLOUR : value;
	};
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const centers = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
	const radiusOf = (id: string): number => byId.get(id)?.radius ?? 0;
	const drawn = edges.filter((e) => byId.has(e.source) && byId.has(e.target));
	const bounds = contentBounds(centers, drawn, radiusOf);
	if (!bounds) return null;
	// Captions are wider than their circles: the picture must not cut them.
	let minX = bounds.x;
	let maxX = bounds.x + bounds.width;
	for (const n of nodes) {
		const half = (Math.min(150, cut(n.caption).length * CAPTION_CHAR) / 2) | 0;
		minX = Math.min(minX, n.x - half);
		maxX = Math.max(maxX, n.x + half);
	}
	const padding = options.padding ?? 24;
	const x = Math.floor(minX - padding);
	const y = Math.floor(bounds.y - padding);
	const width = Math.ceil(maxX + padding) - x;
	const height = Math.ceil(bounds.y + bounds.height + padding) - y;

	const text = paint(theme.text);
	const halo = paint(theme.halo);
	const parts: string[] = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" font-family="${escapeXml(FONT)}">`);
	parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${paint(theme.background)}"/>`);

	for (const e of drawn) {
		const a = byId.get(e.source) as IExportNode;
		const b = byId.get(e.target) as IExportNode;
		const shape = edgeShape(a, b, e.slot, a.radius, b.radius);
		const stroke = paint(e.stroke);
		parts.push(`<g${e.dim ? ` opacity="${DIM_OPACITY}"` : ''}>`);
		parts.push(`<path d="${shape.path}" fill="none" stroke="${stroke}" stroke-width="${fmt(e.width)}"${e.dashed ? ' stroke-dasharray="5 4"' : ''}/>`);
		parts.push(`<polygon points="${shape.arrow}" fill="${stroke}"/>`);
		if (options.labels) {
			const lx = fmt(shape.label.x);
			const ly = fmt(shape.label.y);
			parts.push(`<text x="${lx}" y="${ly}" transform="rotate(${fmt(shape.labelAngle)} ${lx} ${ly})" text-anchor="middle" dominant-baseline="central" font-size="10" fill="${text}" stroke="${halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${escapeXml(e.type)}</text>`);
		}
		parts.push('</g>');
	}

	for (const n of nodes) {
		const cx = fmt(n.x);
		const cy = fmt(n.y);
		parts.push(`<g${n.dim ? ` opacity="${DIM_OPACITY}"` : n.stale ? ` opacity="${STALE_OPACITY}"` : ''}>`);
		if (n.selected) parts.push(`<circle cx="${cx}" cy="${cy}" r="${fmt(n.radius + 4.5)}" fill="none" stroke="${paint(theme.accent)}" stroke-width="3"/>`);
		parts.push(`<circle cx="${cx}" cy="${cy}" r="${fmt(n.radius)}" fill="${paint(n.fill)}" stroke="${paint(theme.border)}" stroke-width="${n.stale ? 2 : 1}"${n.stale ? ' stroke-dasharray="4 3"' : ''}/>`);
		if (n.badgeMode === 'dot') parts.push(`<circle cx="${cx}" cy="${cy}" r="${fmt(Math.max(3, n.radius / 7))}" fill="${paint(n.textColor)}"/>`);
		else if (n.badgeMode === 'initials' && n.badge !== '') {
			parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fmt(Math.round(n.radius * 0.57))}" font-weight="700" fill="${paint(n.textColor)}">${escapeXml(n.badge)}</text>`);
		}
		parts.push(`<text x="${cx}" y="${fmt(n.y + n.radius + 5)}" text-anchor="middle" dominant-baseline="hanging" font-size="${CAPTION_SIZE}" fill="${text}" stroke="${halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${escapeXml(cut(n.caption))}</text>`);
		parts.push('</g>');
	}
	parts.push('</svg>');
	return { svg: parts.join(''), width, height };
}

// =============================================================================
// BROWSER SIDE: colours from the page, PNG from the SVG
// =============================================================================

/**
 * A resolver from any CSS colour (`var(--x)` included) to the colour an element inside `element` shows for it now, as
 * `#rrggbb` (or `rgba()` when it is see-through). The browser does the work: a hidden probe element takes the colour,
 * and a 1 x 1 canvas turns whatever the computed value is (a `color-mix()`, a `color(srgb …)`) into plain numbers.
 *
 * @param element - The element whose variables apply (the canvas container).
 * @returns The resolver; an empty string for a colour the browser does not accept.
 */
export function cssResolver(element: Element): (css: string) => string {
	const page = element.ownerDocument;
	const pixel = page.createElement('canvas');
	pixel.width = 1;
	pixel.height = 1;
	const context = pixel.getContext('2d', { willReadFrequently: true });
	const cache = new Map<string, string>();
	const hex = (n: number): string => n.toString(16).padStart(2, '0');
	return (css) => {
		const known = cache.get(css);
		if (known !== undefined) return known;
		const probe = page.createElement('span');
		probe.style.display = 'none';
		probe.style.color = css;
		let out = '';
		if (probe.style.color !== '') {
			element.appendChild(probe);
			const computed = getComputedStyle(probe).color;
			probe.remove();
			out = computed;
			if (context) {
				// A colour the canvas does not take leaves the sentinel in place: then the computed text is the best there is.
				const sentinel = '#010203';
				context.fillStyle = sentinel;
				context.fillStyle = computed;
				if (context.fillStyle !== sentinel || computed === 'rgb(1, 2, 3)') {
					context.clearRect(0, 0, 1, 1);
					context.fillRect(0, 0, 1, 1);
					const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
					out = a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${r},${g},${b},${fmt(a / 255)})`;
				}
			}
		}
		cache.set(css, out);
		return out;
	};
}

/**
 * The PNG scale for a drawing: twice its size, or less when that would pass what a browser canvas holds.
 *
 * @param width - The SVG's width in pixels.
 * @param height - The SVG's height in pixels.
 * @returns The scale, or 0 when the image would be too small to be of use (a quarter size or less).
 */
export function pngScale(width: number, height: number): number {
	if (!(width > 0) || !(height > 0)) return 0;
	const scale = Math.min(2, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height, Math.sqrt(MAX_CANVAS_AREA / (width * height)));
	return scale < 0.25 ? 0 : scale;
}

/** Why there is no image: a PNG too large for a browser canvas, nothing laid out yet, or the browser could not draw it. */
export type ExportFailure = 'too-large' | 'not-ready' | 'render-failed';

/** An exported image, or why there is none (the view words each reason differently). */
export type ExportResult = { blob: Blob } | { blob: null; reason: ExportFailure };

/** Draws an SVG into a bitmap at a scale and gives the PNG back, or null when the browser could not. */
export type Rasteriser = (svg: string, width: number, height: number, scale: number) => Promise<Blob | null>;

/**
 * The image for a format, from the built SVG, with the reason when there is none. Only a PNG that would be under a
 * quarter of the drawing's size is "too large"; the SVG has no size limit.
 *
 * @param format - SVG or PNG.
 * @param built - The SVG from {@link buildSvg}, or null when nothing is drawn yet.
 * @param rasterise - How a PNG is drawn (the browser's canvas: {@link rasterise}).
 * @returns The image, or why there is none.
 */
export async function exportResult(format: 'svg' | 'png', built: { svg: string; width: number; height: number } | null, rasterise: Rasteriser): Promise<ExportResult> {
	if (!built) return { blob: null, reason: 'not-ready' };
	if (format === 'svg') return { blob: new Blob([built.svg], { type: 'image/svg+xml' }) };
	const scale = pngScale(built.width, built.height);
	if (scale === 0) return { blob: null, reason: 'too-large' };
	let blob: Blob | null;
	try {
		blob = await rasterise(built.svg, built.width, built.height, scale);
	} catch {
		blob = null;
	}
	return blob ? { blob } : { blob: null, reason: 'render-failed' };
}

/**
 * Draw an SVG into a canvas and read it back as a PNG.
 *
 * @param svg - The SVG text (with its own width and height).
 * @param width - Its width in pixels.
 * @param height - Its height in pixels.
 * @param scale - How many canvas pixels per SVG pixel (see {@link pngScale}).
 * @returns The PNG, or null when the browser could not make it (no canvas, the image did not load, no 2D context, or
 *   toBlob gave nothing).
 */
export function rasterise(svg: string, width: number, height: number, scale: number): Promise<Blob | null> {
	if (typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null);
	return new Promise((resolve) => {
		const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
		const finish = (blob: Blob | null): void => {
			URL.revokeObjectURL(url);
			resolve(blob);
		};
		const image = new Image();
		image.onload = () => {
			try {
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(width * scale));
				canvas.height = Math.max(1, Math.round(height * scale));
				const context = canvas.getContext('2d');
				if (!context) {
					finish(null);
					return;
				}
				context.scale(scale, scale);
				context.drawImage(image, 0, 0, width, height);
				canvas.toBlob((blob) => finish(blob), 'image/png');
			} catch {
				finish(null);
			}
		};
		image.onerror = () => finish(null);
		image.src = url;
	});
}
