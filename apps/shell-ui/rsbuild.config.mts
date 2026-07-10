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
import { pluginRocketrideIcons } from 'shared/scripts/rsbuild-plugin-icons.mjs';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';
import { pluginBasicSsl } from '@rsbuild/plugin-basic-ssl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { getenv, requireKeys } = require('../../scripts/lib/getenv');

/**
 * Rsbuild configuration factory for the `shell` host application.
 *
 * This is the Module Federation (MF) host shell.  It does NOT expose any
 * remotes of its own; instead, remote entries (rocket-ui, hello-ui, etc.) are
 * discovered at runtime from the server-provided app manifest via DAP.
 *
 * Key responsibilities:
 * - Inject all `RR_*` environment variables as compile-time `process.env`
 *   defines so the cloud bundle can pass them into ShellConfig at runtime.
 * - Configure MF shared singletons (React, react-dom, shared) to
 *   prevent duplicate module instances across host and remotes.
 * - In development, additionally serve built remote assets and public files
 *   from the repo's top-level `build/` directory.
 * - Output the production bundle to `build/cloud/` (relative to repo root).
 *
 * @param command - Rsbuild lifecycle command: `'dev'` or `'build'`.
 */
export default defineConfig(({ command }) => {
	// Detect whether we are running a development server or a production build.
	// Used to gate dev-only plugins (HTTPS) and server configuration.
	const isDev = command === 'dev';

	// ---------------------------------------------------------------------------
	// Load build-time config: .config (defaults) → .env (overrides).
	//
	// rocketride-server/.config has public OAuth values (Zitadel URL, client IDs)
	// that are safe to commit. The saas-root .env layers secrets and local
	// overrides on top. Remote apps (rocket-ui, brandy-ui) never read
	// process.env — they call useShellApiConfig() instead.
	// ---------------------------------------------------------------------------
	const env = getenv();
	// Only ROCKETRIDE_URI is required for OSS. SaaS keys (Zitadel, Stripe)
	// are optional — the shell feature-flags their UI based on capabilities.
	requireKeys(env, ['ROCKETRIDE_URI'], 'shell-ui');

	// Helper: JSON.stringify a single env var for use in `define` substitution.
	const e = (key: string) => JSON.stringify(env[key] ?? '');

	return {
		server: {
			// Development server listens on port 3000 with HTTPS (via pluginBasicSsl).
			port: 3000,
			// Serve everything from the root path — no sub-directory prefix.
			base: '/',
			// In dev, also serve built app bundles and static assets.
			// public/ is served automatically by rsbuild in both dev and prod.
			...(isDev && {
				// Explicit array replaces rsbuild's default public/ serving entirely,
				// so public/ must be listed here alongside the extra build/ directories.
				publicDir: [
					// Serve static assets (favicon, manifests, etc.) from the app's public/ folder.
					{ name: path.resolve(__dirname, 'public'), watch: false },
					// Serve build/ so /apps/* resolves to built MF remote bundles
					// and /apps.json resolves to the generated app manifest.
					{ name: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? path.resolve(__dirname, '../../build')), watch: false },
				],
			}),
		},
		plugins: [
			// Enable HTTPS in dev so the MF host and remotes share the same origin
			// scheme — mixed HTTP/HTTPS would block cross-origin requests in browsers.
			// ...(isDev ? [pluginBasicSsl()] : []),

			// Standard React JSX transform + Fast Refresh support.
			pluginReact(),

			// SVGR + auto-currentcolor svgo plugin for node icons (used by canvas).
			pluginRocketrideIcons(),

			// Module Federation plugin — declares this bundle as the `cloud` host.
			pluginModuleFederation({
				// The federation name used to identify this container to remotes.
				// Namespaced to avoid collisions with third-party MF modules.
				name: 'rocketride_shell',

				// No static remotes are declared here; remotes are added dynamically
				// at runtime from the server manifest JSON.
				remotes: {},

				shared: {
					// eager: true puts react/react-dom in the synchronous initial chunk so they
					// are fully initialized before the async bootstrap boundary runs. Without this,
					// MF singleton negotiation races with the async import and two React instances
					// can end up active simultaneously, breaking batchedUpdates and fiber roots.
					react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
					'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },

					// shared is an internal package; version enforcement is skipped
					// (requiredVersion: false) because it is always co-deployed.
					// MF shared resolution bypasses rsbuild aliases — explicit import
					// paths are required so MF can find the modules at build time.
					'shell-ui': { singleton: true, version: '1.0.0', requiredVersion: false, eager: true, import: path.resolve(__dirname, './src/index.ts') },
					'shared':   { singleton: true, version: '1.0.0', requiredVersion: false, eager: true, import: path.resolve(__dirname, '../../packages/shared-ui/src/index.ts') },
					// shaders bundles Three.js internally — do NOT add 'three' to shared or
				// the host exposes a copy that shaders never imports, wasting ~1-2MB.
				'shaders':  { singleton: true, version: '1.0.0', requiredVersion: false, eager: true },
				},

				// Skip TypeScript declaration file generation for MF exposed modules —
				// the repo uses a direct path alias instead.
				dts: false,
			}),
		],
		html: {
			template: './index.html',
			title: 'RocketRide',

			// Browser tab / bookmark favicon — points to an SVG in the public folder.
			favicon: './public/favicon.svg',
		},
		resolve: {
			alias: {
				// Allow `import ... from 'shared'` to resolve to the shared-ui package
				// inside the rocketride-server submodule without a publish/link step.
				// shared-ui lives in the same repo — resolve directly.
				shared: path.resolve(__dirname, '../../packages/shared-ui/src'),

				// shell-ui source lives inside this app; alias resolves to the
				// local index.ts so imports work identically across host and remotes.
				'shell-ui': path.resolve(__dirname, './src/index.ts'),
			},
		},
		source: {
			// Build entry points — each produces a separate HTML page and JS bundle.
			entry: {
				index: './src/index.tsx',
			},

			// Compile-time constant substitution.
			//
			// ONLY the five variables below are injected into the browser bundle.
			// Every key listed here becomes a string literal at build time — nothing
			// else from the .env file is ever included.
			//
			// SECURITY: never add server-side secrets here (RR_STRIPE_SECRET_KEY,
			// RR_STRIPE_WEBHOOK_SECRET, RR_DB_URL, RR_ZITADEL_SERVICE_TOKEN, etc.).
			// Those values are never needed in the browser and must stay server-side.
			define: {
				// Standard Node.js env flag — enables React's production optimisations.
				'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),

				// WebSocket URI for the RocketRide server.
				'process.env.ROCKETRIDE_URI': e('ROCKETRIDE_URI'),

				// Dev/service-account API key — bypasses OAuth2 when set.
				// Leave empty in production; only set in .env for local development.
				'process.env.RR_APIKEY': e('RR_APIKEY'),

				// Stripe publishable key — safe to expose in the browser (pk_*).
				// Never put the secret key (sk_*) here.
				'process.env.RR_STRIPE_PUBLISHABLE_KEY': e('RR_STRIPE_PUBLISHABLE_KEY'),

				// Zitadel OIDC issuer URL — required for OAuth2 PKCE flow.
				'process.env.RR_ZITADEL_URL': e('RR_ZITADEL_URL'),

				// Zitadel OAuth2 client ID registered for this SPA.
				'process.env.RR_ZITADEL_CLIENT_ID': e('RR_ZITADEL_CLIENT_ID'),

				// OAuth broker root URL — read at module load by shared-ui/config/oauth.ts;
				// shell-ui bundles shared-ui from source so it must define this (like rslib/vscode).
				'process.env.REACT_APP_OAUTH_ROOT_URL': e('REACT_APP_OAUTH_ROOT_URL'),
			},
		},
		dev: {
			// Disable lazy compilation. It's incompatible with this dev setup
			// (custom assetPrefix '/shell/' + writeToDisk + Module Federation): the
			// on-demand `*_lazy-compilation-proxy` chunk for the async bootstrap
			// boundary (index.tsx -> import('./bootstrap')) fails to load after a
			// full-page navigation such as the OAuth redirect round-trip, throwing
			// ChunkLoadError and triggering an HMR reload loop. Compiling everything
			// up front keeps the bootstrap chunk always available.
			lazyCompilation: false,

			// Write built assets to disk during development so that the static file
			// server (and other processes) can read the latest MF remote entries.
			writeToDisk: true,

			// Match production prefix so dev and prod asset paths are consistent.
			assetPrefix: '/shell/',

			// Watch the two aliased package sources for changes so that HMR
			// picks up edits to shared-ui without a manual restart. shell-ui lives inside src/ and is watched automatically.
			watchFiles: {
				paths: [
					path.resolve(__dirname, '../../packages/shared-ui/src'),
				],
			},

		},
		output: {
			// Write the production bundle to build/shell-ui/ at the repo root so that
			// all app bundles live under a single top-level build/ directory.
			distPath: { root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'shell-ui') },

			// Prefix all asset URLs with /shell/ so they route through the shell
			// module's public endpoints. Without this, assets load from /static/
			// which hits the auth middleware and gets 401.
			assetPrefix: '/shell/',

			// Remove stale files from the output directory before each build to
			// prevent leftover chunks from a previous build being served.
			cleanDistPath: true,

			// Copy theme JSON files into the build output so they are served at
			// /shell/themes/*.json in both dev and production.  rsbuild's publicDir
			// serves files at the root path, but assetPrefix: '/shell/' means the
			// app requests /shell/themes/ — placing them in the build output
			// ensures they resolve correctly under the prefix.
			copy: [
				{ from: path.resolve(__dirname, 'public/themes'), to: 'themes' },
			],
		},
	};
});
