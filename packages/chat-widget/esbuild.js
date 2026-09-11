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

/**
 * chat-widget bundle build (mirrors apps/vscode/esbuild.js conventions).
 *
 * Produces the two single-file browser bundles from one source tree:
 *   dist/rocketride-chat.mjs — ESM, for bundler/import consumers (web-component mode);
 *                              .mjs so Node parses it as ESM despite the package's
 *                              "type": "commonjs" (kept for the CJS build scripts)
 *   dist/rocketride-chat.js  — IIFE, for <script src> consumers (launcher-bubble mode)
 *
 * The workspace 'rocketride' SDK is bundled from its TypeScript source
 * (packages/client-typescript/src/client) so this package builds standalone
 * without requiring the SDK's dist/ to exist first — esbuild compiles the TS
 * directly and the output is equivalent to bundling dist/esm.
 *
 * The SDK's optional Node-only 'ws' dependency is aliased to a stub: browsers
 * use the native WebSocket and never reach the dynamic import('ws') path, but
 * without the stub esbuild would try to bundle ws and its Node built-ins.
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const production = process.argv.includes('--production');

const PACKAGE_DIR = __dirname;
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const DIST_DIR = path.join(PACKAGE_DIR, 'dist');
const SDK_DIR = path.resolve(PACKAGE_DIR, '..', 'client-typescript');
const SDK_ENTRY = path.join(SDK_DIR, 'src', 'client', 'index.ts');
const WS_STUB = path.join(SRC_DIR, 'stubs', 'ws.ts');

const pkg = require('./package.json');

// IIFE entry: the script-tag launcher bubble (auto-initialises from its own
// <script> tag's data-* attributes). Until the loader entry lands, fall back to
// the plain component entry so <script src> + <rocketride-chat> markup works.
const esmEntry = path.join(SRC_DIR, 'index.ts');
const iifeEntryPreferred = path.join(SRC_DIR, 'entry-iife.ts');
const iifeEntry = fs.existsSync(iifeEntryPreferred) ? iifeEntryPreferred : esmEntry;
if (iifeEntry !== iifeEntryPreferred) {
	console.warn('[chat-widget] src/entry-iife.ts not found — building the IIFE bundle from src/index.ts (web component only, no launcher bubble).');
}

// The declaration-emit step that follows in the "build" script (tsc -p
// tsconfig.types.json) resolves the 'rocketride' package types from
// client-typescript/dist/types. On a fresh clone the SDK hasn't been built
// yet, so generate its declarations here (a few seconds, no-op when present).
// The supported entry point is `./builder chat-widget:build`, which runs
// `client-typescript:generate-types` first and never reaches this branch; this
// only covers a direct `pnpm --filter rocketride-chat-widget build`.
//
// `shell` is required on Windows: npx resolves to npx.cmd, and Node >= 20.12.2
// refuses to spawn a .cmd/.bat without a shell (CVE-2024-27980 hardening). The
// argument list below is fixed and space-free, so shell quoting is not a
// concern. This mirrors what scripts/lib/exec.js does for the builder itself.
if (!fs.existsSync(path.join(SDK_DIR, 'dist', 'types', 'index.d.ts'))) {
	console.log('[chat-widget] generating rocketride SDK type declarations (client-typescript/dist/types)...');
	execFileSync('npx', ['tsc', '-p', 'tsconfig.types.json'], { cwd: SDK_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
}

/** @type {import('esbuild').BuildOptions} */
const common = {
	bundle: true,
	platform: 'browser',
	target: 'es2020',
	minify: production,
	sourcemap: true,
	logLevel: 'info',
	banner: {
		js: `/*! ${pkg.name} v${pkg.version} | MIT | https://rocketride.ai */`,
	},
	alias: {
		// Bundle the workspace SDK from source (see header comment).
		rocketride: SDK_ENTRY,
		// Node-only optional dependency of the SDK; never used in browsers.
		ws: WS_STUB,
	},
};

Promise.all([
	esbuild.build({
		...common,
		entryPoints: [esmEntry],
		format: 'esm',
		outfile: path.join(DIST_DIR, 'rocketride-chat.mjs'),
	}),
	esbuild.build({
		...common,
		entryPoints: [iifeEntry],
		format: 'iife',
		globalName: 'RocketRideChat',
		outfile: path.join(DIST_DIR, 'rocketride-chat.js'),
	}),
]).catch((error) => {
	console.error('esbuild failed:', error);
	process.exit(1);
});
