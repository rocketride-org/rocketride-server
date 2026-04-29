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
const fs = require('fs');

const production = process.argv.includes('--production');
const outfile = path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'vscode/rocketride.js');

// ---------------------------------------------------------------------------
// Parse a key=value file (comments and blank lines ignored).
// ---------------------------------------------------------------------------
function parseFile(filePath) {
	try {
		const text = fs.readFileSync(filePath, 'utf8');
		const result = {};
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq < 0) continue;
			result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		}
		return result;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Load build-time constants from the repo root .env file.
// These are baked into the extension bundle so they don't need to be in the
// user's workspace .env — they are our infrastructure values, not user config.
// ---------------------------------------------------------------------------
// Load .config first (defaults), then .env on top (overrides).
// ---------------------------------------------------------------------------
function loadBuildEnv() {
	const roots = [
		path.resolve(__dirname, '../..'), // rocketride repo root
		path.resolve(__dirname, '../../..'), // saas repo root
	];
	for (const root of roots) {
		const config = parseFile(path.join(root, '.config'));
		const env = parseFile(path.join(root, '.env'));
		const merged = { ...config, ...env };
		if (Object.keys(merged).length > 0) return merged;
	}
	return {};
}

const env = loadBuildEnv();

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
