// =============================================================================
// APARAVI-UI — Module Federation Remote (Aparavi AQL Chat)
// =============================================================================
// Builds remoteEntry.js + AppDescriptor chunk only.
// NOT a standalone app. Run shell-ui:dev for development.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const moduleId = (pkg.appManifest?.id ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');

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
				// runtime: false — the host (shell-ui) provides the MF runtime;
				// remotes don't embed their own copy, keeping remoteEntry.js
				// stable across app-code-only rebuilds.
				runtime: false,
				shared: {
					// eager: true makes shared-scope negotiation synchronous on
					// both host and remote, eliminating the async deadlock that
					// hangs the browser when only one remote is recompiled.
					react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
					'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
					// import: false tells MF to NOT bundle a fallback copy —
					// the host (shell-ui) always provides these at runtime.
					'shell-ui': { singleton: true, requiredVersion: false, import: false },
					'shared':   { singleton: true, requiredVersion: false, import: false },
				},
			}),
		],
		// No resolve aliases — all shared modules (shell-ui, shared, react)
		// resolve through node_modules (pnpm workspace link) and MF provides
		// the host's singleton at runtime.
		resolve: {},
		tools: {
			// Treat .pipe files as JSON so the pipeline definition can be imported.
			rspack: {
				module: {
					rules: [{ test: /\.pipe$/, type: 'json' }],
				},
			},
		},
		server: { port: 3018 },
		source: {
			entry: {
				index: './src/index.ts',
			},
		},
		output: {
			distPath: {
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'apps', 'aparavi-ui'),
			},
			assetPrefix: 'auto',
			cleanDistPath: true,
			sourceMap: {
				js: 'source-map',
				css: true,
			},
		},
	};
});
