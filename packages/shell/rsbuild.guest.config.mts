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

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sdkVersion: string = require('../client-typescript/package.json').version;

/**
 * Rsbuild configuration of the GUEST runtime (#1022 PR2b, plan section 3.4).
 *
 * The guest is the Module Federation host that runs inside an isolated app's
 * frame, on the app's own origin. The engine serves it from `/_rr/<name>` by
 * exact name only (the `chunks` list in runtime.json, `_GUEST_ASSET`), so the
 * output is pinned shut:
 * - flat: every `distPath` subdirectory is '' (one path segment under /_rr/);
 * - every file name starts with `guest-`;
 * - `assetPrefix` is '/_rr/' (the public path chunks load from);
 * - nothing else is emitted: no html (frame.html is written by
 *   shell:guest-copy), no license files, no source maps, no MF manifest or
 *   types, and no pre-encoded variants (P10: the edge encodes).
 * Production flavor only.
 */
export default defineConfig({
	plugins: [
		pluginReact(),
		pluginModuleFederation({
			name: 'rocketride_guest',
			remotes: {},
			shareStrategy: 'loaded-first',
			shared: {
				// Eager singletons, as in the shell host: 'react', 'react-dom', 'react/jsx-runtime',
				// 'rocketride' and 'shell' (prettier unquotes the first key).
				react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react/jsx-runtime': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				// The app's 'rocketride' is the same SDK; its client INSTANCE is the guest's brokered one.
				rocketride: { singleton: true, version: sdkVersion, requiredVersion: false, eager: true, import: path.resolve(__dirname, '../../packages/client-typescript/src/client/index.ts') },
				// The app's 'shell' is the guest shell module: the public surface with the Appendix A names denied.
				shell: { singleton: true, version: '1.0.0', requiredVersion: false, eager: true, import: path.resolve(__dirname, './src/guest/shellModule.ts') },
			},
			manifest: false,
			dts: false,
		}),
	],
	resolve: {
		alias: {
			shell$: path.resolve(__dirname, './src/guest/shellModule.ts'),
			shell: path.resolve(__dirname, '.'),
		},
	},
	source: {
		entry: { boot: './src/guest/boot.ts' },
		define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	},
	// The shell's public/ (favicon, themes) is not part of the guest: nothing is copied.
	server: {
		publicDir: false,
	},
	tools: {
		htmlPlugin: false,
	},
	output: {
		distPath: {
			root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'shell-guest'),
			js: '',
			jsAsync: '',
			css: '',
			cssAsync: '',
			svg: '',
			font: '',
			image: '',
			media: '',
			assets: '',
			wasm: '',
		},
		filename: {
			js: 'guest-[name].[contenthash:8].js',
			css: 'guest-[name].[contenthash:8].css',
			svg: 'guest-[name].[contenthash:8].svg',
			font: 'guest-[name].[contenthash:8][ext]',
			image: 'guest-[name].[contenthash:8][ext]',
			media: 'guest-[name].[contenthash:8][ext]',
			assets: 'guest-[name].[contenthash:8][ext]',
		},
		assetPrefix: '/_rr/',
		legalComments: 'none',
		sourceMap: false,
		cleanDistPath: true,
	},
});
