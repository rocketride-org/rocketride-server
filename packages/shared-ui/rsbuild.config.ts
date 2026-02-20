// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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
 * Rsbuild development/application build configuration for the shared-ui package.
 *
 * Used when running the package as a standalone app (e.g. for local dev/storybook).
 * Configures the entry point, output directory structure, source maps, and plugins.
 */
import { defineConfig } from '@rsbuild/core';
import { pluginSass } from '@rsbuild/plugin-sass';
import { pluginReact } from '@rsbuild/plugin-react';

/** Rsbuild configuration for application-mode builds. */
export default defineConfig({
	source: {
		entry: {
			index: './index.tsx',
		},
	},
	output: {
		distPath: {
			root: `dist`,
			js: 'static-shared/js',
			jsAsync: 'static-shared/js/async',
			css: 'static-shared/css',
			cssAsync: 'static-shared/css/async',
			svg: 'static-shared/svg',
			font: 'static-shared/font',
			wasm: 'static-shared/wasm',
			image: 'static-shared/image',
			media: 'static-shared/media',
		},
		sourceMap: {
			js: 'cheap-module-source-map',
		},
		polyfill: 'usage',
		cleanDistPath: true,
	},
	plugins: [pluginSass(), pluginReact()],
});
