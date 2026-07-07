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
 * Shared Rsbuild plugin for RocketRide icon handling.
 *
 *   - Every `import Icon from 'foo.svg'` becomes an SVGR React component.
 *   - Monochrome SVGs are auto-rewritten to use `currentColor` so they
 *     inherit the active theme color; multicolor brand logos pass through
 *     unchanged. See `./svgo-auto-currentcolor.mjs`.
 *   - SVGs loaded via `import.meta.webpackContext` also go through SVGR
 *     (the no-query rule's issuer filter is removed — see setup below).
 *
 * Usage from an app's rsbuild.config.{ts,mts,mjs}:
 *
 *     import { pluginRocketrideIcons } from 'shared/build/rsbuild-plugin-icons.mjs';
 *
 *     export default defineConfig({
 *       plugins: [pluginReact(), pluginRocketrideIcons()],
 *     });
 */

import path from 'node:path';
import { pluginSvgr } from '@rsbuild/plugin-svgr';
import autoCurrentColor from './svgo-auto-currentcolor.mjs';

/** @returns {import('@rsbuild/core').RsbuildPlugin} */
export const pluginRocketrideIcons = () => ({
	name: 'rocketride:icons',
	setup(api) {
		pluginSvgr({
			svgrOptions: {
				// Default export = React component (matches our import style).
				exportType: 'default',
				// Forward refs to the underlying <svg> so the Icon renderer can
				// namespace each instance's internal ids (gradients/clipPaths) at
				// runtime. Without unique ids, multiple copies of the same icon in
				// the DOM collide on `url(#id)` and only the first paints correctly.
				ref: true,
				// Let parent CSS control icon size.
				dimensions: false,
				svgoConfig: {
					plugins: [
						// Keep viewBox; otherwise `width: auto; height: 1rem`
						// computes to zero width (svgo's default removeViewBox
						// strips it when width/height attributes exist, and
						// SVGR's `dimensions: false` then removes those too).
						{
							name: 'preset-default',
							// removeComments must stay disabled: our autoCurrentColor plugin
							// reads <!-- preserve-colors --> comments to opt brand SVGs out of
							// auto-tinting. preset-default's removeComments runs before custom
							// plugins and would strip the marker before we ever see it.
							params: { overrides: { removeViewBox: false, removeComments: false } },
						},
						autoCurrentColor,
					],
				},
			},
		}).setup(api);

		// SVGs loaded via `import.meta.webpackContext` (or `require.context`)
		// have a synthetic context module as their issuer, not a .tsx file.
		// plugin-svgr's no-query SVG rule restricts issuer to JS/TS/MDX, so
		// context-loaded SVGs fall through to the default asset loader (data
		// URI) instead of SVGR. Remove the issuer filter so SVGR fires
		// regardless of how the SVG is imported.
		//
		// Also alias `react` / `react-dom` to the consuming app's local copy.
		// SVGR's generated module imports `react/jsx-runtime`; when the SVG
		// lives under `nodes/src/nodes/<node>/` (no node_modules anywhere up
		// the directory tree from there), Rspack cannot resolve react. The
		// alias pins resolution to the app's own install regardless of the
		// importer's location. We skip if the app has already configured a
		// react alias (e.g. apps/vscode does this explicitly).
		api.modifyBundlerChain((chain, { CHAIN_ID }) => {
			if (chain.module.rules.has(CHAIN_ID.RULE.SVG)) {
				const svgRule = chain.module.rules.get(CHAIN_ID.RULE.SVG);
				if (svgRule.oneOfs.has(CHAIN_ID.ONE_OF.SVG)) {
					svgRule.oneOfs.get(CHAIN_ID.ONE_OF.SVG).delete('issuer');
				}
			}

			const appRoot = api.context.rootPath;
			if (!chain.resolve.alias.has('react')) {
				chain.resolve.alias.set(
					'react',
					path.resolve(appRoot, 'node_modules/react'),
				);
			}
			if (!chain.resolve.alias.has('react-dom')) {
				chain.resolve.alias.set(
					'react-dom',
					path.resolve(appRoot, 'node_modules/react-dom'),
				);
			}
		});
	},
});

export default pluginRocketrideIcons;
