// MIT License
//
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
// THEMED SVG IMAGE — an SVG that follows the surrounding foreground color
// =============================================================================
//
// An SVG loaded through <img> renders in its own document: `currentColor`
// never reaches it, and every path WITHOUT an explicit fill paints the SVG
// default (black) — invisible-to-wrong on a dark sidebar. This component
// fetches the SVG text, sanitizes it, and INLINES it so normal CSS
// inheritance decides the colors:
//
//   - paths that declare their own fill/stroke keep them (an authored color
//     always wins — presentation attributes beat inherited values), and
//   - paths that declare nothing inherit `fill: currentColor` from the
//     wrapper instead of defaulting to black, so the icon follows the
//     theme's foreground wherever it is placed (title, body, rail, ...).
//
// Only `fill` is seeded on the wrapper: stroke's initial value is 'none', so
// forcing it would outline filled shapes that never asked for a stroke.
//
// Failure (fetch error, non-SVG payload) falls back to the plain <img> the
// caller would have rendered anyway.
// =============================================================================

import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';

// =============================================================================
// FETCH + SANITIZE CACHE
// =============================================================================

/** url -> sanitized SVG markup ('' while in flight is never cached). */
const svgCache = new Map<string, string>();

/**
 * Fetches and sanitizes one SVG. Strips every element class that can carry
 * active or externally-loading content (script, foreignObject, style,
 * iframe/embed/object, SMIL animation, external <use>), every on* handler,
 * and javascript:/data: hrefs — the markup is inlined into the page, so it
 * must carry no active content.
 *
 * @param src - The SVG URL.
 * @returns Sanitized outer markup, or null when the payload is unusable.
 */
async function loadSvg(src: string): Promise<string | null> {
	const cached = svgCache.get(src);
	if (cached !== undefined) return cached;
	try {
		const res = await fetch(src, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return null;
		const text = await res.text();
		const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
		const root = doc.documentElement;
		if (root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;
		// step: whole element classes go, not just scripts — <style> can
		// @import/url() external CSS, iframe/embed/object embed documents,
		// and SMIL animation (<animate attributeName="href" values="js:…">)
		// can WRITE the very attributes the pass below scrubs
		for (const el of Array.from(doc.querySelectorAll('script, foreignObject, style, iframe, embed, object, animate, animateTransform, animateMotion, set'))) el.remove();
		for (const el of Array.from(doc.querySelectorAll('*'))) {
			for (const attr of Array.from(el.attributes)) {
				if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
				if (/href$/i.test(attr.name)) {
					// step: <use> may only reference in-document fragments;
					// everywhere else, no scriptable/data schemes
					const external = el.tagName.toLowerCase() === 'use' && !attr.value.trim().startsWith('#');
					if (external || /^\s*(javascript|data):/i.test(attr.value)) el.removeAttribute(attr.name);
				}
			}
		}
		// An SVG with no declared size would inline at 100% width — give it a
		// text-sized height instead (authored width/height always win).
		if (!root.hasAttribute('width') && !root.hasAttribute('height')) {
			root.setAttribute('height', '1em');
		}
		const markup = root.outerHTML;
		svgCache.set(src, markup);
		return markup;
	} catch {
		return null;
	}
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link ThemedSvgImage}. */
export interface ThemedSvgImageProps {
	/** The SVG URL. */
	src: string;
	/** Accessible label (the markdown alt text). */
	alt?: string;
	/**
	 * Render height in px — overrides the SVG's declared size (the width
	 * follows the viewBox's aspect ratio when one is declared). Omitted, the
	 * SVG keeps its authored size.
	 */
	size?: number;
	/** Extra styles on the wrapper (spacing, alignment). */
	style?: CSSProperties;
}

/**
 * Inlines a remote SVG so it inherits the surrounding text color. Authored
 * colors inside the SVG are preserved; see the file header for the rules.
 * Falls back to a plain <img> while loading or when the fetch fails.
 *
 * @param props - See {@link ThemedSvgImageProps}.
 */
export const ThemedSvgImage: React.FC<ThemedSvgImageProps> = ({ src, alt, size, style }) => {
	const [markup, setMarkup] = useState<string | null>(() => svgCache.get(src) ?? null);

	// Caller-sized rendering: rewrite the root dimensions (a wrapper max-size
	// would clip, not shrink, an inline SVG). Height wins; width rides the
	// viewBox aspect when one is declared.
	const sized = useMemo(() => {
		if (markup === null || size == null) return markup;
		const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
		const root = doc.documentElement;
		root.setAttribute('height', String(size));
		if (root.hasAttribute('viewBox')) root.removeAttribute('width');
		else root.setAttribute('width', String(size));
		return root.outerHTML;
	}, [markup, size]);

	useEffect(() => {
		let disposed = false;
		if (svgCache.get(src) !== undefined) {
			setMarkup(svgCache.get(src)!);
			return;
		}
		setMarkup(null);
		void loadSvg(src).then((m) => {
			if (!disposed && m !== null) setMarkup(m);
		});
		return () => {
			disposed = true;
		};
	}, [src]);

	// Loading or unusable: the plain image the caller would have rendered.
	if (sized === null) return <img src={src} alt={alt ?? ''} style={{ maxWidth: '100%', ...(size != null ? { height: size } : {}), verticalAlign: 'text-bottom', ...style }} />;

	return (
		<span
			role={alt ? 'img' : undefined}
			aria-label={alt || undefined}
			aria-hidden={alt ? undefined : true}
			style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'text-bottom', color: 'inherit', fill: 'currentColor', ...style }}
			dangerouslySetInnerHTML={{ __html: sized }}
		/>
	);
};
