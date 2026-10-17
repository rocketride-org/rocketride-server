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

// =============================================================================
// DEV-TOOL WEBVIEW BUILD — the one webview that is a Module Federation HOST
// =============================================================================
//
// The main webview build (rsbuild.config.mjs) deliberately disables all code
// splitting and inlines every dynamic import — settings that are incompatible
// with Module Federation (loadRemote needs real async chunk loading). This
// separate build produces ONLY the page-devtool entry, with MF enabled and a
// normal chunk graph, into its own output directory (webview/devtool/) so the
// two builds never collide.
//
// Share contract: store-app remotes are built `runtime: false` with
// react/react-dom shared and `import: false` on shell/rocketride — this host
// MUST provide all four as eager singletons (mirrors the shell host's config
// in packages/shell/rsbuild.config.mts).
//
// Chunk URLs: `assetPrefix: 'auto'` derives the public path from the loading
// script's own URL — which the DevToolPanelProvider rewrites to a
// webview-resource URI — so the host's async chunks resolve inside the
// webview origin, while the remote's chunks resolve against the engine
// origin (remotes are built with assetPrefix 'auto' too).

/* global process */
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';
import { pluginRocketrideIcons } from '../shared/scripts/rsbuild-plugin-icons.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const { getenv } = require('../../scripts/lib/getenv');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = getenv();

// The SDK version for the share scope — read from the package the remotes
// were built against (same convention as the shell host).
const sdkVersion = JSON.parse(readFileSync(path.resolve(__dirname, '../../packages/client-typescript/package.json'), 'utf8')).version;

export default defineConfig({
	plugins: [
		pluginReact(),
		pluginRocketrideIcons(),
		pluginModuleFederation({
			name: 'rocketride_vscode_devtool',
			// Remotes are registered at RUNTIME from the live connection
			// (registerRemotes with the engine's versioned entry URL).
			remotes: {},
			shareStrategy: 'loaded-first',
			dts: false,
			shared: {
				react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				// Remotes carry import:false for these two — the host copy is
				// the ONLY copy, so both must be eager singletons here.
				shell: { singleton: true, version: '1.0.0', requiredVersion: false, eager: true, import: path.resolve(__dirname, 'node_modules/shell/src/index.ts') },
				rocketride: { singleton: true, version: sdkVersion, requiredVersion: false, eager: true, import: path.resolve(__dirname, '../../packages/client-typescript/src/client/index.ts') },
			},
		}),
	],

	source: {
		define: {
			'process.env.REACT_APP_OAUTH_ROOT_URL': JSON.stringify(env.REACT_APP_OAUTH_ROOT_URL || ''),
		},
		// The workspace-linked shell package ships TypeScript source; include
		// it (and this app's own src) for transpilation — same as the main
		// webview build.
		include: ['./src/**/*', path.resolve(__dirname, '../../packages/shell'), path.resolve(__dirname, '../../packages/client-typescript')],
		exclude: ['./dist/**', './node_modules/**', './**/*.test.*', './**/*.spec.*'],
		entry: {
			'page-devtool': './src/providers/views/DevTool/index.tsx',
		},
	},

	resolve: {
		aliasStrategy: 'prefer-alias',
		alias: {
			shared: path.resolve(__dirname, '../shared/src'),
			// The SDK's TransportWebSocket has a Node-only dynamic import('ws')
			// fallback — stub it for the browser bundle.
			ws: false,
			react: path.resolve(__dirname, 'node_modules/react'),
			'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
		},
	},

	output: {
		distPath: {
			// Own directory — the main webview build cleans ITS dist on every
			// run; sharing one root would let either build delete the other's
			// chunks.
			root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'vscode/webview/devtool'),
		},
		// Chunk URLs derive from the loading script's URL (rewritten by the
		// provider to a webview-resource URI).
		assetPrefix: 'auto',
		sourceMap: {
			js: false,
			css: false,
		},
		externals: {
			vscode: 'commonjs vscode',
		},
		cleanDistPath: true,
		// Small static assets still inline (webviews can't resolve arbitrary
		// emitted paths from CSS); JS chunks are real files by design here.
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
			},
		},
	},
});
