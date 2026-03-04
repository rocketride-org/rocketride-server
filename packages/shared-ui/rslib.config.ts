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
 * Rslib library build configuration for the shared-ui package.
 *
 * Produces a CommonJS bundle of the Canvas module intended to be consumed
 * by the VS Code extension webview.  React is externalised so the host
 * provides the shared instance.  Environment variables are inlined via `define`.
 */
import { defineConfig } from '@rslib/core';
import { pluginSass } from '@rsbuild/plugin-sass';
import { pluginReact } from '@rsbuild/plugin-react';

/**
 * Builds the `source.define` map that inlines environment variables at compile time.
 * Provides sensible defaults for `VERSION`, `NODE_ENV`, and Google Picker API keys.
 *
 * @returns A record of `process.env.*` replacements for the bundler.
 */
function buildDefine() {
	return {
		'process.env.VERSION': JSON.stringify(process.env.VERSION || '1.0.0'),
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
		'process.env.REACT_APP_GOOGLE_PICKER_CLIENT_ID': JSON.stringify(
			process.env.REACT_APP_GOOGLE_PICKER_CLIENT_ID || ''
		),
		'process.env.REACT_APP_GOOGLE_PICKER_DEVELOPER_KEY': JSON.stringify(
			process.env.REACT_APP_GOOGLE_PICKER_DEVELOPER_KEY || ''
		),
	};
}

/** Rslib configuration for the CJS library build targeting VS Code extension webviews. */
export default defineConfig({
	// Library configuration - externalize React to use shared instance
	lib: [
		{
			format: 'cjs',
			dts: false,
			bundle: true,
			autoExternal: false, // We'll manually specify externals
		},
	],

	// Source configuration
	source: {
		entry: {
			index: './src/modules/canvas/index.tsx',
		},
		define: buildDefine(),
	},

	// Output configuration
	output: {
		target: 'web',
		distPath: {
			root: './dist',
		},
		externals: {
			react: 'react',
			'react-dom': 'react-dom',
			'react/jsx-runtime': 'react/jsx-runtime',
		},
	},

	// Tools configuration
	tools: {
		rspack: {
			optimization: {
				minimize: process.env.NODE_ENV === 'production',
			},
		},
	},

	// Plugins
	plugins: [pluginSass(), pluginReact()],
});
