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

/* global process */
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginRocketrideIcons } from 'shared/scripts/rsbuild-plugin-icons.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getenv } = require('../../scripts/lib/getenv');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = getenv();
// The publishable key only enables the embedded checkout — every consumer
// gates on it being non-empty, so a key-less build is functional with the
// checkout panels disabled. Warn instead of failing: standalone repos have
// no .config defaults; marketplace builds supply the key via .env.
if (!env.RR_STRIPE_PUBLISHABLE_KEY) {
	console.warn('[vscode:build-webview] RR_STRIPE_PUBLISHABLE_KEY not set - building with the embedded checkout disabled');
}

export default defineConfig({
	plugins: [pluginReact(), pluginRocketrideIcons()],

	source: {
		// Inject public build-time config values into webview bundles.
		// SECURITY: never add server-side secrets here — only publishable keys.
		define: {
			'process.env.RR_STRIPE_PUBLISHABLE_KEY': JSON.stringify(env.RR_STRIPE_PUBLISHABLE_KEY || ''),
			'process.env.ROCKETRIDE_URI': JSON.stringify(env.ROCKETRIDE_URI || 'https://api.rocketride.ai'),
			// OAuth broker base URL for the social-login buttons (shared-ui OAUTH_ROOT_URL).
			'process.env.REACT_APP_OAUTH_ROOT_URL': JSON.stringify(env.REACT_APP_OAUTH_ROOT_URL || ''),
		},
		include: ['./src/**/*'],
		exclude: ['./dist/**', './node_modules/**', './**/*.test.*', './**/*.spec.*'],
		entry: {
			'page-sidebar': './src/providers/views/Sidebar/index.tsx',
			'page-settings': './src/providers/views/Settings/index.tsx',
			'page-project': './src/providers/views/Project/index.tsx',
			'page-welcome': './src/providers/views/Welcome/index.tsx',
			'page-monitor': './src/providers/views/Monitor/index.tsx',
			'page-account': './src/providers/views/Account/index.tsx',
			'page-environment': './src/providers/views/Environment/index.tsx',
			'page-app': './src/providers/views/App/index.tsx',
		},
	},

	resolve: {
		alias: {
			// shared is a STATIC library the webviews compile from source, so
			// its whole tree stays reachable via 'shared/<group>' deep specs.
			shared: path.resolve(__dirname, '../../shared/src'),
			// shell is the CONTRACT, satisfied by the vendored shell package
			// ("shell": "file:../../.rocketride/shell" in package.json,
			// extracted from the server's shell.tgz — per pack-shell,
			// static hosts bundle its compiled code). No alias: ordinary
			// node_modules resolution applies the package's exports map,
			// which only exposes the barrel and the sanctioned CSS/token
			// entries — deep shell paths fail the build, the same
			// enforcement out-of-repo consumers get from shell.d.ts.
			react: path.resolve(__dirname, 'node_modules/react'),
			'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
		},
	},

	output: {
		distPath: {
			root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'vscode/webview'),
		},
		filename: {
			js: '[name].js',
		},
		sourceMap: {
			js: false,
			css: false,
		},
		externals: {
			vscode: 'commonjs vscode',
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
				runtimeChunk: false,
			},
			module: {
				parser: {
					javascript: {
						// splitChunks:false does NOT cover dynamic import() —
						// rspack still emits an async chunk per import() site
						// (the component gallery's lazy demos), and the webview
						// never ships those files. Eager mode inlines every
						// dynamic import into the single bundle instead.
						dynamicImportMode: 'eager',
					},
				},
			},
		},
	},

	performance: {
		// Disable chunk splitting at the Rsbuild level too
		chunkSplit: {
			strategy: 'all-in-one',
		},
	},
});
