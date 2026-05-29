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
 * Node icon renderer.
 *
 * Each node owns its SVG file (placed next to its service JSON inside
 * `nodes/src/nodes/<node>/`). At build time, Rsbuild scans the directory
 * via `import.meta.webpackContext` (Webpack 5 / Rspack API), transforms
 * each SVG into a React component via SVGR, and the custom
 * `auto-currentcolor` svgo plugin rewrites monochrome SVGs to use
 * `currentColor` so they inherit the active theme color.
 *
 * Multicolor brand logos pass through unchanged and render in their
 * authored colors.
 */

import * as React from 'react';

/** Matches absolute http(s)/ftp URLs (e.g. icons supplied by remote services). */
const isUrl = (value: string): boolean =>
	/^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i.test(value);

type SvgComponent = React.FC<React.SVGProps<SVGSVGElement>>;

// Build-time directory scan. The path is 6 levels up from this file:
//   packages/shared-ui/src/components/canvas/util/ → repo root → nodes/src/nodes/
// Each match resolves to an SVGR-generated React component (default export).
const iconContext = import.meta.webpackContext(
	'../../../../../../nodes/src/nodes',
	{ recursive: true, regExp: /\.svg$/, mode: 'sync' },
);

// filename (without extension) → component
const iconComponents = new Map<string, SvgComponent>();
for (const key of iconContext.keys()) {
	const file = key.split('/').pop() ?? '';
	const base = file.replace(/\.svg$/i, '');
	// Duplicate icons across node dirs are byte-identical by convention;
	// last-wins is intentional and harmless.
	const mod = iconContext<{ default: SvgComponent }>(key);
	iconComponents.set(base, mod.default);
}

const UnknownIcon = iconComponents.get('unknown');

export type IconProps = React.SVGProps<SVGSVGElement> & {
	/**
	 * Icon identifier. Accepted forms:
	 *   - a known icon name with or without extension, e.g. `"openai"` or `"openai.svg"`
	 *   - a full URL (rendered via `<img>` instead of inline SVG)
	 *   - undefined or unrecognized — falls back to the `unknown` icon
	 */
	name?: string;
	/** Used when the icon resolves to a remote URL (the `<img>` fallback). */
	alt?: string;
};

/**
 * Renders a node icon. Monochrome icons inherit `color` via `currentColor`
 * so they re-tint automatically with the theme. Multicolor brand icons
 * render in their authored colors.
 */
// Default `color` resolves to the theme contract token `--rr-icon-color`,
// falling back to the legacy view variable `--icon-color` if the token is
// not defined in the current document (e.g. the VS Code webview, which
// sets `--icon-color` directly via `body[data-vscode-theme-kind=...]`).
// Monochrome SVGs (auto-rewritten to `currentColor` at build time) pick
// up whichever value resolves first. Multicolor brand SVGs ignore it
// because their fills are hardcoded. Callers can override by passing
// `style={{ color: ... }}`.
const DEFAULT_STYLE: React.CSSProperties = {
	color: 'var(--rr-icon-color, var(--icon-color))',
};

export const Icon: React.FC<IconProps> = ({ name, alt = '', style, ...svgProps }) => {
	const mergedStyle: React.CSSProperties = { ...DEFAULT_STYLE, ...style };

	if (!name) {
		return UnknownIcon ? <UnknownIcon {...svgProps} style={mergedStyle} /> : null;
	}

	if (isUrl(name)) {
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

	const key = name.replace(/\.(svg|png|jpg|jpeg)$/i, '');
	const Component = iconComponents.get(key) ?? UnknownIcon;
	return Component ? <Component {...svgProps} style={mergedStyle} /> : null;
};

export default Icon;
