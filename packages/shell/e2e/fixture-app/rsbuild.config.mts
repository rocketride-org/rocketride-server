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

// =============================================================================
// E2E FIXTURE APP: a real Module Federation remote (#1022 PR2c)
// =============================================================================
// Builds `remoteEntry.js` plus its chunks into `e2e/.build/fixture-app/`, the
// same shape the app build worker harvests into a version's dist/. The host
// (the shell, or the guest runtime in an isolated frame) provides react,
// react-dom, `shell` and `rocketride`, so none of them is bundled here.
// `sw.js` ships beside it so the X5 scenario has a script to register.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Two builds share this source: the hostile third-party app (the default) and the
// platform home app the shell opens when nothing else is requested (E2E_BUILD=home),
// which gives the suite the shell's own chrome (sidebar, log out).
const HOME = process.env.E2E_BUILD === 'home';
const APP_ID = HOME ? 'rocketride.hello' : 'e2e.fixture';
const MODULE = HOME ? 'e2e_home' : 'e2e_fixture';

export default defineConfig({
	plugins: [
		pluginReact(),
		pluginModuleFederation({
			name: MODULE,
			filename: 'remoteEntry.js',
			exposes: { './AppDescriptor': path.join(__dirname, 'src/AppDescriptor.js') },
			dts: false,
			runtime: false,
			shareStrategy: 'loaded-first',
			shared: {
				react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				shell: { singleton: true, requiredVersion: false, import: false },
				rocketride: { singleton: true, requiredVersion: false, import: false },
			},
		}),
	],
	source: { entry: { index: path.join(__dirname, 'src/index.js') }, define: { __E2E_APP_ID__: JSON.stringify(APP_ID) } },
	output: {
		distPath: { root: path.join(__dirname, '..', '.build', HOME ? 'home-app' : 'fixture-app') },
		assetPrefix: 'auto',
		cleanDistPath: true,
		sourceMap: false,
		copy: [{ from: path.join(__dirname, 'src/sw.js'), to: 'sw.js' }],
	},
	tools: {
		rspack: { resolve: { alias: { shell: path.join(__dirname, 'src/shell-types.js'), rocketride: path.join(__dirname, 'src/shell-types.js') } } },
	},
});
