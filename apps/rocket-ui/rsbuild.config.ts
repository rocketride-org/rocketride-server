// =============================================================================
// ROCKET-UI — Module Federation Remote
// =============================================================================
// Builds remoteEntry.js + AppDescriptor chunk only.
// NOT a standalone app. Run apps/cloud for development.
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
const moduleId = (pkg.appManifest?.id ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');

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
					'shell/client': { singleton: true, requiredVersion: false, import: false },
				},
			}),
		],
		resolve: {
			alias: {
				shared: path.resolve(__dirname, '../shared/src'),
				// The vendored shell package (compiled): only a fallback — at
				// runtime the host's MF share scope provides 'shell'.
				'shell$': path.resolve(__dirname, '../../.rocketride/shell/dist/index.js'),
			},
		},
		// CORS: explicitly allow any origin — the serving host isn't fixed, so no
		// allowlist is possible; declaring it also stops the MF plugin injecting
		// its own wildcard defaults (and warning about it).
		server: { port: 3010, cors: { origin: '*' } },
		source: {
			entry: {
				index: './src/index.ts',
			},
			// shared-ui's config/oauth.ts reads this env var at MODULE LOAD, so any
			// bundle that compiles shared-ui from source must define it (the shell
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
				config.module ??= {};
				config.module.rules ??= [];
				config.module.rules.push(
					{
						resourceQuery: /raw/,
						type: 'asset/source',
					},
					{
						test: /\.md$/,
						type: 'asset/source',
					},
				);

				config.plugins ??= [];
				config.plugins.push(
					new rspack.CopyRspackPlugin({
						patterns: [
							{
								from: path.resolve(__dirname, 'src/assets'),
								to: 'assets',
								globOptions: {
									ignore: ['**/*.d.ts'],
								},
							},
							{
								from: path.resolve(__dirname, 'src/README.md'),
								to: 'README.md',
							},
						],
					}),
				);
			},
		},
		output: {
			distPath: { root: '../../build/apps/rocket-ui' },
			// 'auto' derives the public path from remoteEntry.js's load URL at runtime,
			// so chunks resolve correctly regardless of which server/path hosts the remote.
			assetPrefix: 'auto',
			cleanDistPath: true,
			sourceMap: { js: 'source-map', css: true },
		},
	};
});
