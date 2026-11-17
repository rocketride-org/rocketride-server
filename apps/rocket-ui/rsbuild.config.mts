/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
// =============================================================================
// ROCKET-UI — Module Federation Remote
// =============================================================================
// Builds remoteEntry.js + AppDescriptor chunk only.
// NOT a standalone app. Run shell:dev for development.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginSass } from '@rsbuild/plugin-sass';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';
// Node-icon handling (SVGR + currentColor auto-tint + webpackContext issuer fix).
// rocket-ui is an MF remote that bundles the canvas — and therefore the node
// SVGs loaded via Icon.tsx's import.meta.webpackContext — into its OWN bundle,
// so it must run SVGR itself (the shell host's copy doesn't process rocket-ui's
// modules). Without this the SVGs bundle as asset URLs, not React components, and
// no node icons render. Same plugin apps/vscode and packages/shell use.
import { pluginRocketrideIcons } from '../shared/scripts/rsbuild-plugin-icons.mjs';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
// The app id is the SERVED identity: the builder keys the build output dir,
// the served static dir, and the apps.json URL on it, so the rsbuild distPath
// MUST match (build/apps/<appId>). moduleId is the MF container name.
const appId = pkg.appManifest?.id;
if (typeof appId !== 'string' || appId.length === 0) {
	// A fallback id would publish a malformed app under build/apps/unknown
	// and break the remote delivery contract — fail the build instead.
	throw new Error('package.json must define a non-empty appManifest.id');
}
const moduleId = appId.replace(/[^a-zA-Z0-9_$]/g, '_');

// Load build-time config (.config defaults -> repo-root .env overrides) via
// the repo's shared helper so env layering matches the shell host.
const { getenv } = require('../../scripts/lib/getenv');
const env = getenv();

export default defineConfig(() => {
	return {
		plugins: [
			pluginSass(),
			pluginReact(),
			pluginRocketrideIcons(),
			pluginModuleFederation({
				name: moduleId,
				filename: 'remoteEntry.js',
				exposes: {
					'./AppDescriptor': './src/AppDescriptor.ts',
				},
				dts: false,
				// runtime: false — the host (the shell) provides the MF runtime;
				// remotes don't embed their own copy, keeping remoteEntry.js
				// stable across app-code-only rebuilds.
				runtime: false,
				// loaded-first: use the host's already-loaded shared instances instead of
				// version-first's boot-time download of EVERY registered remoteEntry.js
				// just to compare shared versions (everything here is singleton + co-deployed).
				shareStrategy: 'loaded-first',
				shared: {
					// eager: true makes shared-scope negotiation synchronous on
					// both host and remote, eliminating the async deadlock that
					// hangs the browser when only one remote is recompiled.
					react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
					'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
					'shell': { singleton: true, requiredVersion: false, import: false },
					'rocketride': { singleton: true, requiredVersion: false, import: false },
				},
			}),
		],
		resolve: {
			alias: {
				shared: path.resolve(__dirname, '../shared/src'),
				// shell carries NO alias: the fallback resolves through the
				// INSTALLED platform package (the workspace's canonical
				// .rocketride/shell/shell.tgz) — at runtime the host's MF
				// share scope provides 'shell' anyway.
			},
		},
		// CORS: explicitly allow any origin — the serving host isn't fixed, so no
		// allowlist is possible; declaring it also stops the MF plugin injecting
		// its own wildcard defaults (and warning about it).
		server: { port: 3010, cors: { origin: '*' } },
		// hmr on; liveReload stays at its DEFAULT (true): a failed hot update
		// that rejects check() falls back to a full reload of the preview page.
		// lazyCompilation stays off: this bundle runs INSIDE the preview shell's
		// page (a different origin), so the lazy-compilation client's relative
		// "active modules" XHR resolves against the SHELL's origin and 401s on
		// the platform server — the first async chunk (Monaco) kills the dev
		// session. Compile-on-request also made every served bundle one hash
		// behind, so the dev client always saw itself as stale.
		// client: same different-origin problem for the HMR websocket — without
		// an explicit host the client derives its URL from the shell page's
		// location and never reaches this dev server. '<port>' is rsbuild's
		// runtime placeholder for the ACTUAL bound port.
		dev: { hmr: true, lazyCompilation: false, client: { protocol: 'ws', host: 'localhost', port: '<port>' } as const },
		source: {
			entry: {
				index: './src/index.ts',
			},
			// shared's config/oauth.ts reads this env var at MODULE LOAD, so any
			// bundle that compiles shared from source must define it (the shell
			// host does the same). Needed here because the project module
			// (ProjectView/canvas) bundles into rocket-ui instead of riding the
			// shell's 'shared' share. Optional: '' falls back to the library's
			// production default URL.
			define: {
				'process.env.REACT_APP_OAUTH_ROOT_URL': JSON.stringify(env.REACT_APP_OAUTH_ROOT_URL ?? ''),
			},
		},
		tools: {
			rspack: (config, { rspack }) => {
				// react-refresh/babel (the HMR instrumenter) carries a GUARDED
				// require('crypto') for signature hashing; the dev session passes
				// emitFullSignatures so the path never runs — stub the builtin so
				// the browser bundle resolves.
				config.resolve ??= {};
				(config.resolve as { fallback?: Record<string, false | string> }).fallback = {
					...(config.resolve as { fallback?: Record<string, false | string> }).fallback,
					crypto: false,
				};
				// typescript.js (lazy-loaded by appdev ATA) references
				// __filename/__dirname in its Node-only sys layer, which never
				// runs in the browser (ts.sys is undefined there). Opting into
				// the mock explicitly keeps rspack's default substitution but
				// silences its warn-variant on every build.
				config.node = {
					...config.node,
					__filename: 'mock',
					__dirname: 'mock',
				};
				config.module ??= {};
				config.module.rules ??= [];
				config.module.rules.push(
					// typescript.js's resolveJSModule carries a require(<expression>)
					// in that same Node-only sys layer — unreachable in the browser.
					// Marking expression requires non-critical for this one module
					// drops the "Critical dependency" warning every (re)build would
					// otherwise forward into the preview console.
					{
						test: /node_modules[\\/]typescript[\\/]lib[\\/]typescript\.js$/,
						parser: { exprContextCritical: false },
					},
					{
						resourceQuery: /raw/,
						type: 'asset/source',
					},
					{
						test: /\.md$/,
						type: 'asset/source',
					},
					// Treat .pipe files as JSON so pipeline definitions can be imported.
					{
						test: /\.pipe$/,
						type: 'json',
					},
				);

				config.plugins ??= [];
				config.plugins.push(
					new rspack.CopyRspackPlugin({
						patterns: [
							{
								from: path.resolve(__dirname, 'assets'),
								to: 'assets',
								globOptions: {
									ignore: ['**/*.d.ts'],
								},
							},
							{
								from: path.resolve(__dirname, 'README.md'),
								to: 'README.md',
							},
						],
					}),
				);
			},
		},
		output: {
			// Honor the builder's overlay build root (saas mode) so the bundle
			// lands where the copy step reads it; standalone falls back to the
			// repo-relative build dir.
			distPath: { root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'apps', appId) },
			// 'auto' derives the public path from remoteEntry.js's load URL at runtime,
			// so chunks resolve correctly regardless of which server/path hosts the remote.
			assetPrefix: 'auto',
			cleanDistPath: true,
			sourceMap: { js: 'source-map', css: true } as const,
		},
	};
});
