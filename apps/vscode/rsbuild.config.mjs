// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [
		pluginReact(),
	],

	source: {
		include: ['./src/**/*'],
		exclude: [
			'./dist/**',
			'./node_modules/**',
			'./**/*.test.*',
			'./**/*.spec.*'
		],
		entry: {
			'page-connection': './src/providers/views/PageConnection/index.tsx',
			'page-settings': './src/providers/views/PageSettings/index.tsx',
			'page-editor': './src/providers/views/PageEditor/index.tsx',
			'page-status': './src/providers/views/PageStatus/index.tsx',
			'page-deploy': './src/providers/views/PageDeploy/index.tsx',
			'page-welcome': './src/providers/views/PageWelcome/index.tsx'
		}
	},

	resolve: {
		alias: {
			'shared': path.resolve(__dirname, '../../packages/shared-ui/src/index.tsx'),
			'react': path.resolve(__dirname, 'node_modules/react'),
			'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
		}
	},

	output: {
		distPath: {
			root: '../../build/vscode/webview'
		},
		filename: {
			js: '[name].js'
		},
		sourceMap: {
			js: false,
			css: false
		},
		externals: {
			'vscode': 'commonjs vscode'
		},
		cleanDistPath: true,
		// Inline all static assets as data URIs — VS Code webviews cannot
		// resolve emitted file paths set dynamically from JavaScript.
		dataUriLimit: Number.MAX_SAFE_INTEGER,
	},

	html: {
		template: './src/providers/template.html',
	},

	mode: 'production',

	tools: {
		rspack: {
			optimization: {
				minimize: false,
				// CRITICAL: Disable all code splitting for VS Code webviews
				splitChunks: false,
				runtimeChunk: false
			}
		}
	},

	performance: {
		// Disable chunk splitting at the Rsbuild level too
		chunkSplit: {
			strategy: 'all-in-one'
		}
	}
});

