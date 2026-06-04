// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * SVGO plugin: auto-detect monochrome SVGs and rewrite their fill/stroke
 * colors to `currentColor` so they inherit the theme color when rendered
 * as inline `<svg>` elements.
 *
 * Detection rule
 *   - Collect distinct color values from element fill/stroke attributes,
 *     inline `style="..."` attributes, and embedded `<style>` blocks.
 *   - Ignore: `none`, `transparent`, `currentColor`, `inherit`, `initial`,
 *     `unset`, and `url(#...)` references.
 *   - Any `<linearGradient>`, `<radialGradient>`, or `<pattern>` element
 *     forces multicolor treatment (leave SVG unchanged).
 *   - If exactly one distinct color remains, rewrite every occurrence to
 *     `currentColor`. Otherwise, leave the SVG unchanged.
 *
 * Contributor experience: drop any SVG into the build pipeline. Monochrome
 * line art adapts to the active theme automatically. Multicolor brand logos
 * pass through with their authored colors intact.
 */

const COLOR_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color'];

const COLOR_DECL_RE =
	/\b(fill|stroke|stop-color|flood-color|lighting-color)\s*:\s*([^;}\s][^;}]*?)\s*(?=[;}]|$)/gi;

const SKIP_VALUES = new Set([
	'none',
	'transparent',
	'currentcolor',
	'inherit',
	'initial',
	'unset',
]);

const isUrlRef = (value) => /^url\s*\(/i.test(value);

// CSS declarations may end with `!important`. We strip it before classification
// (so `none !important` still matches SKIP_VALUES) and re-append it when
// rewriting (so cascade priority is preserved).
const IMPORTANT_SUFFIX_RE = /\s*!important\s*$/i;
const stripImportant = (value) => value.replace(IMPORTANT_SUFFIX_RE, '').trim();

const shouldCount = (value) => {
	if (!value) return false;
	const lower = stripImportant(value).toLowerCase();
	if (SKIP_VALUES.has(lower)) return false;
	if (isUrlRef(lower)) return false;
	return true;
};

// Normalize so equivalent values land in the same Set bucket
// (e.g. `#FFF` and `#ffffff` both → `#ffffff`).
const normalizeColor = (value) => {
	const v = stripImportant(value).toLowerCase();
	const shortHex = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
	if (shortHex) {
		const [, r, g, b] = shortHex;
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return v.replace(/\s+/g, ' ');
};

const extractColorsFromCss = (cssText) => {
	if (!cssText) return [];
	const out = [];
	COLOR_DECL_RE.lastIndex = 0;
	let match;
	while ((match = COLOR_DECL_RE.exec(cssText)) !== null) {
		const value = match[2];
		if (shouldCount(value)) out.push(normalizeColor(value));
	}
	return out;
};

const replaceColorsInCss = (cssText) => {
	return cssText.replace(COLOR_DECL_RE, (_full, prop, value) => {
		if (shouldCount(value)) {
			const important = IMPORTANT_SUFFIX_RE.test(value) ? ' !important' : '';
			return `${prop}: currentColor${important}`;
		}
		return `${prop}: ${value}`;
	});
};

export const name = 'autoCurrentColor';
export const description =
	'Auto-detect monochrome SVGs and rewrite color attributes to currentColor';

export const fn = () => {
	const colors = new Set();
	let hasMulticolorMarker = false;
	let hasPreserveMarker = false;

	// Refs collected during traversal so we can mutate them in root.exit
	// once we know whether the SVG is monochrome.
	const attrRefs = []; // { node, attr }
	const styleAttrNodes = []; // nodes carrying a `style="..."` attribute
	const styleBlockTexts = []; // text/cdata children of <style> elements

	return {
		comment: {
			enter: (node) => {
				if (node.value.trim() === 'preserve-colors') hasPreserveMarker = true;
			},
		},
		element: {
			enter: (node) => {
				if (
					node.name === 'linearGradient' ||
					node.name === 'radialGradient' ||
					node.name === 'pattern'
				) {
					hasMulticolorMarker = true;
				}

				for (const attr of COLOR_ATTRS) {
					const val = node.attributes[attr];
					if (shouldCount(val)) {
						colors.add(normalizeColor(val));
						attrRefs.push({ node, attr });
					}
				}

				const styleAttr = node.attributes.style;
				if (styleAttr) {
					const cssColors = extractColorsFromCss(styleAttr);
					if (cssColors.length > 0) {
						for (const c of cssColors) colors.add(c);
						styleAttrNodes.push(node);
					}
				}

				if (node.name === 'style') {
					for (const child of node.children ?? []) {
						if (child.type === 'text' || child.type === 'cdata') {
							const cssColors = extractColorsFromCss(child.value);
							if (cssColors.length > 0) {
								for (const c of cssColors) colors.add(c);
								styleBlockTexts.push(child);
							}
						}
					}
				}
			},
		},
		root: {
			exit: () => {
				if (hasMulticolorMarker || hasPreserveMarker) return;
				if (colors.size !== 1) return;

				for (const { node, attr } of attrRefs) {
					node.attributes[attr] = 'currentColor';
				}
				for (const node of styleAttrNodes) {
					node.attributes.style = replaceColorsInCss(node.attributes.style);
				}
				for (const child of styleBlockTexts) {
					child.value = replaceColorsInCss(child.value);
				}
			},
		},
	};
};

export default { name, description, fn };
