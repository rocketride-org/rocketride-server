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
 * Node icon renderer — server-supplied icons, no build-time bundling.
 *
 * Nodes are self-contained and can be added/removed on the server at any
 * time, so no build-time icon set can be correct. Icons arrive with the
 * services summary (`getServices()`): each service's `icon` field is an
 * opaque id into the response's deduplicated `icons` table of raw SVG
 * text. Hosts call {@link registerServiceIcons} with that response
 * whenever services (re)load — the registry lives and dies with the
 * services list.
 *
 * Every registered SVG goes through a client-side pipeline once:
 *   1. sanitize — parse, drop scripting-capable elements/attributes
 *      (third-party nodes ship icons; inlined SVG is an injection vector),
 *   2. auto-currentColor — monochrome icons get their single color
 *      replaced with `currentColor` so they re-tint with the theme
 *      (multicolor brand logos pass through in their authored colors).
 *
 * Rendering inlines the SVG and namespaces its internal ids per instance
 * (the same icon appears many times per document; browsers resolve
 * `url(#id)` to the FIRST match). Unknown/missing names fall back to the
 * built-in `unknown` glyph; full URLs render via `<img>`.
 */

import * as React from 'react';

/** Matches absolute http(s)/ftp URLs (e.g. icons supplied by remote services). */
const isUrl = (value: string): boolean =>
	/^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i.test(value);

// The built-in fallback glyph (generic "node" mark) — the ONE icon that must
// exist before any server has been contacted. Monochrome by design: fill is
// currentColor so it follows the theme like every processed icon.
const UNKNOWN_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor"><path d="M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z"/></svg>';

// =============================================================================
// SVG PROCESSING (sanitize + auto-currentColor)
// =============================================================================

/** Fill/stroke values that are not "a color" for monochrome detection. */
const NON_COLORS = new Set(['none', 'transparent', 'currentcolor', 'inherit', '']);

/**
 * Sanitizes and theme-enables one raw SVG text.
 *
 * Parses the text as SVG, removes scripting-capable content (script,
 * foreignObject, event-handler attributes, javascript: URLs), applies the
 * auto-currentColor rewrite when the icon is monochrome, and returns the
 * serialized result. Returns null when the text does not parse as SVG —
 * a bad icon must never break rendering (callers fall back to unknown).
 *
 * @param text - Raw SVG text as served in the services icon table.
 * @returns Safe, theme-enabled SVG text, or null when unusable.
 */
function processSvg(text: string): string | null {
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(text, 'image/svg+xml');
	} catch {
		return null;
	}
	const root = doc.documentElement;
	if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;

	// step: strip scripting-capable elements and attributes
	doc.querySelectorAll('script, foreignObject').forEach((el) => el.remove());
	const all = [root, ...Array.from(root.querySelectorAll('*'))];
	for (const el of all) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith('on') || /javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
		}
	}

	// step: monochrome detection — collect the distinct real colors used by
	// fill/stroke attributes (url(#...) paint refs and non-colors ignored)
	const colors = new Set<string>();
	for (const el of all) {
		for (const attrName of ['fill', 'stroke']) {
			const value = el.getAttribute(attrName)?.trim();
			if (!value || value.startsWith('url(')) continue;
			if (NON_COLORS.has(value.toLowerCase())) continue;
			colors.add(value.toLowerCase());
		}
	}

	// step: exactly one color -> rewrite it to currentColor so the icon
	// re-tints with the theme; anything else is a multicolor brand mark
	if (colors.size === 1) {
		const [only] = colors;
		for (const el of all) {
			for (const attrName of ['fill', 'stroke']) {
				const value = el.getAttribute(attrName)?.trim();
				if (value && value.toLowerCase() === only) el.setAttribute(attrName, 'currentColor');
			}
		}
	}

	return new XMLSerializer().serializeToString(root);
}

// =============================================================================
// ICON REGISTRY (populated from the services summary)
// =============================================================================

// icon id (and service name) -> processed SVG text. Replaced wholesale on
// every registerServiceIcons() call — the registry mirrors the services
// list and shares its lifecycle (reload on connection).
const iconRegistry = new Map<string, string>();

/** The minimal slice of a services summary the registry consumes. */
export interface ServiceIconsSource {
	/** Service name -> summary entry carrying the `icon` id. */
	services?: Record<string, { icon?: string } | undefined>;
	/** Deduplicated icon table: icon id -> raw SVG text. */
	icons?: Record<string, string>;
}

/**
 * (Re)builds the icon registry from a services summary response.
 *
 * Call whenever the services list (re)loads — on connection in the shell /
 * rocket-ui, on the services bridge message in the vscode webviews. Icons
 * are registered under their table id (what `service.icon` holds, so
 * `<Icon name={service.icon}>` resolves directly) and under each service
 * name that references them.
 *
 * @param source - The `getServices()` response (or its services/icons slice).
 */
export function registerServiceIcons(source: ServiceIconsSource | null | undefined): void {
	iconRegistry.clear();
	if (!source) return;
	// step: process each distinct SVG once, keyed by its table id
	for (const [id, text] of Object.entries(source.icons ?? {})) {
		const processed = typeof text === 'string' ? processSvg(text) : null;
		if (processed) iconRegistry.set(id, processed);
	}
	// step: alias every service name onto its icon
	for (const [name, entry] of Object.entries(source.services ?? {})) {
		const iconId = entry?.icon;
		if (iconId && iconRegistry.has(iconId)) iconRegistry.set(name, iconRegistry.get(iconId)!);
	}
}

// Lazily processed fallback (registry-independent, never cleared).
let unknownProcessed: string | null = null;
const getUnknownSvg = (): string => (unknownProcessed ??= processSvg(UNKNOWN_SVG) ?? UNKNOWN_SVG);

// =============================================================================
// RENDERING
// =============================================================================

export type IconProps = React.SVGProps<SVGSVGElement> & {
	/**
	 * Icon identifier. Accepted forms:
	 *   - an icon id or service name from the services summary
	 *   - a full URL (rendered via `<img>` instead of inline SVG)
	 *   - undefined or unrecognized — falls back to the `unknown` icon
	 */
	name?: string;
	/** Used when the icon resolves to a remote URL (the `<img>` fallback). */
	alt?: string;
};

// Default `color` resolves to the theme contract token `--rr-icon-color`,
// falling back to the legacy view variable `--icon-color` if the token is
// not defined in the current document (e.g. the VS Code webview, which
// sets `--icon-color` directly via `body[data-vscode-theme-kind=...]`).
// Monochrome SVGs (rewritten to `currentColor` at registration) pick up
// whichever value resolves first. Multicolor brand SVGs ignore it because
// their fills are hardcoded. Callers can override via `style={{ color }}`.
const DEFAULT_STYLE: React.CSSProperties = {
	color: 'var(--rr-icon-color, var(--icon-color))',
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Namespaces every internal id in a rendered icon SVG — and the references to
 * them — with a per-instance suffix.
 *
 * The shell keeps multiple canvases mounted at once, and a single canvas can
 * hold several copies of the same node, so the same icon SVG (with its
 * hardcoded gradient/clipPath ids) appears many times in one document.
 * Browsers resolve `url(#id)` to the FIRST matching id in the DOM, so without
 * this every duplicate after the first loses its gradient/clip (e.g. the
 * Telegram icon's blue fill). Runs in-place on the live SVG element.
 */
const namespaceSvgIds = (svg: SVGSVGElement, uid: string): void => {
	const suffix = `__${uid}`;
	const renames = new Map<string, string>();
	svg.querySelectorAll('[id]').forEach((el) => {
		const oldId = el.getAttribute('id');
		if (!oldId || oldId.endsWith(suffix)) return;
		const newId = oldId + suffix;
		el.setAttribute('id', newId);
		renames.set(oldId, newId);
	});
	if (renames.size === 0) return;
	const rewrite = (el: Element): void => {
		for (const attr of Array.from(el.attributes)) {
			if (!attr.value.includes('#')) continue;
			let next = attr.value;
			renames.forEach((newId, oldId) => {
				// Matches `url(#id)`, `url('#id')` and bare `#id` (href), but not when
				// followed by an id char — so it never re-rewrites the new id.
				next = next.replace(new RegExp(`#${escapeRegExp(oldId)}(?![\\w-])`, 'g'), `#${newId}`);
			});
			if (next !== attr.value) el.setAttribute(attr.name, next);
		}
	};
	rewrite(svg);
	svg.querySelectorAll('*').forEach(rewrite);
};

/**
 * Inlines one processed SVG text and namespaces its ids per instance.
 *
 * The host span carries the color/style so `currentColor` icons inherit the
 * theme; width/height props are stamped onto the inner <svg> to preserve the
 * sizing behavior of the old component-based renderer.
 */
const InlineSvgIcon: React.FC<{ svg: string } & React.SVGProps<SVGSVGElement>> = ({ svg, width, height, className, style }) => {
	const uid = React.useId().replace(/:/g, '');
	const hostRef = React.useRef<HTMLSpanElement>(null);
	React.useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		host.innerHTML = svg;
		const el = host.querySelector('svg');
		if (!el) return;
		if (width != null) el.setAttribute('width', String(width));
		if (height != null) el.setAttribute('height', String(height));
		namespaceSvgIds(el as SVGSVGElement, uid);
	}, [svg, uid, width, height]);
	return <span ref={hostRef} className={className} style={{ display: 'inline-flex', lineHeight: 0, ...style }} />;
};

export const Icon: React.FC<IconProps> = ({ name, alt = '', style, ...svgProps }) => {
	const mergedStyle: React.CSSProperties = { ...DEFAULT_STYLE, ...style };

	if (name && isUrl(name)) {
		// Remote/external URL — render as <img>. Forward props that apply to
		// both element types (width/height/style/className) so callers don't
		// need a separate code path for the URL case.
		const { width, height, className } = svgProps as React.SVGProps<SVGSVGElement>;
		return (
			<img
				src={name}
				alt={alt}
				width={width as number | string | undefined}
				height={height as number | string | undefined}
				style={style as React.CSSProperties | undefined}
				className={className}
			/>
		);
	}

	// Registry lookup: exact id/name first, then without a file extension
	// (legacy callers may still pass "openai.svg"-style names).
	const key = name?.replace(/\.(svg|png|jpg|jpeg)$/i, '');
	const svg = (name && iconRegistry.get(name)) || (key && iconRegistry.get(key)) || getUnknownSvg();
	return <InlineSvgIcon svg={svg} {...svgProps} style={mergedStyle} />;
};

export default Icon;
