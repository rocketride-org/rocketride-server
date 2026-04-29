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
// Load build-time constants from the repo root .env file.
// These are baked into the extension bundle so they don't need to be in the
// user's workspace .env — they are our infrastructure values, not user config.
// ---------------------------------------------------------------------------
function loadEnv() {
	// Walk up from apps/vscode to find the repo root .env
	const candidates = [
		path.resolve(__dirname, '../../.env'), // rocketride-server root
		path.resolve(__dirname, '../../../.env'), // saas repo root
	];
	for (const p of candidates) {
		try {
			const text = fs.readFileSync(p, 'utf8');
			const env = {};
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;
				const eq = trimmed.indexOf('=');
				if (eq < 0) continue;
				env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
			}
			return env;
		} catch {
			/* try next */
		}
	}
	return {};
}

const env = loadEnv();

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
			// Bake in Zitadel / cloud config at build time.
			//
			// All three values are PUBLIC and safe to ship in the bundle.
			// The Zitadel client is a PKCE/public-client (no secret), the same
			// pattern GitHub Desktop, gh CLI, VS Code's first-party auth
			// providers, and Slack desktop all use. The defense against a
			// leaked client_id is the strict redirect-URI allowlist on the
			// Zitadel side — only `vscode://rocketride.rocketride/auth/callback`
			// is accepted, so a hostile rebuild can't redirect tokens elsewhere.
			//
			// Forks / contributors pointing at their own Zitadel can override
			// any of these via env vars at build time.
			'process.env.RR_ZITADEL_URL': JSON.stringify(env.RR_ZITADEL_URL || 'https://auth.rocketride.ai'),
			'process.env.RR_ZITADEL_CLIENT_ID': JSON.stringify(env.RR_ZITADEL_VSCODE_CLIENT_ID || env.RR_ZITADEL_CLIENT_ID || '368801673541427525'),
			'process.env.RR_CLOUD_URL': JSON.stringify(env.RR_CLOUD_URL || 'https://cloud.rocketride.ai'),
		},
		loader: {
			'.json': 'json',
		},
	})
	.catch((error) => {
		console.error('esbuild failed:', error);
		process.exit(1);
	});
