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

const esbuild = require('esbuild');
const path = require('path');

const { getenv, requireKeys } = require('../../scripts/lib/getenv');

const production = process.argv.includes('--production');
const outfile = path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'vscode/rocketride.js');

const env = getenv();
requireKeys(env, ['ROCKETRIDE_URI', 'RR_ZITADEL_URL', 'RR_ZITADEL_VSCODE_CLIENT_ID'], 'vscode');

esbuild
	.build({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: true,
		platform: 'node',
		target: 'node16',
		outfile,
		external: ['vscode'],
		alias: {
			// docker-modem requires ssh2 at load time, but we only use local socket.
			// Stub it out so no native .node binaries are needed.
			ssh2: path.resolve(__dirname, 'src/stubs/ssh2.js'),
		},
		mainFields: ['main'],
		resolveExtensions: ['.ts', '.js', '.json'],
		logLevel: 'info',
		packages: 'bundle',
		define: {
			// Disable AMD detection
			define: 'undefined',
			// Server URI default (workspace .env overrides at runtime)
			'process.env.ROCKETRIDE_URI': JSON.stringify(env.ROCKETRIDE_URI || ''),
			// Zitadel OIDC config (.config defaults, .env overrides)
			'process.env.RR_ZITADEL_URL': JSON.stringify(env.RR_ZITADEL_URL || ''),
			'process.env.RR_ZITADEL_VSCODE_CLIENT_ID': JSON.stringify(env.RR_ZITADEL_VSCODE_CLIENT_ID || ''),
		},
		loader: {
			'.json': 'json',
		},
	})
	.catch((error) => {
		console.error('esbuild failed:', error);
		process.exit(1);
	});
