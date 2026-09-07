/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
// =============================================================================
// MONITOR-UI — Module Federation Remote (Server Monitor app)
// =============================================================================
// Builds remoteEntry.js + AppDescriptor chunk only.
// NOT a standalone app. Run shell:dev for development.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

export default defineConfig(() => {
	return {
		plugins: [
			pluginReact(),
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
					// import: false tells MF to NOT bundle a fallback copy —
					// the host (the shell) always provides these at runtime.
					// Without this, MF bundles the entire shared tree
					// (fonts, Chart.js, MUI) as a "just in case" fallback.
					'shell': { singleton: true, requiredVersion: false, import: false },
					'rocketride': { singleton: true, requiredVersion: false, import: false },
				},
			}),
		],
		// No resolve aliases — all shared modules (shell, shared, react)
		// resolve through node_modules (pnpm workspace link) and MF provides
		// the host's singleton at runtime. This prevents bundling duplicate
		// fonts/CSS from shared into each remote app.
		resolve: {},
		// CORS: explicitly allow any origin — the serving host isn't fixed, so no
		// allowlist is possible; declaring it also stops the MF plugin injecting
		// its own wildcard defaults (and warning about it).
		// Treat .pipe files as JSON so pipeline definitions can be imported.
		// `as const` keeps the rule's `type` a literal for the config typecheck.
		tools: {
			rspack: {
				module: {
					rules: [{ test: /\.pipe$/, type: 'json' } as const],
				},
			},
		},
		server: { port: 3016, cors: { origin: '*' } },
		source: {
			entry: {
				index: './src/index.ts',
			},
		},
		output: {
			distPath: {
				// Honor the builder's overlay build root when set; standalone falls
				// back to the repo-relative build dir.
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'apps', appId),
			},
			assetPrefix: 'auto',
			cleanDistPath: true,
			sourceMap: {
				js: 'source-map',
				css: true,
			} as const,
		},
	};
});
