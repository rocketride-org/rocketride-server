// =============================================================================
// SQL-UI — Module Federation Remote (SQL database workbench)
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
					'shell': { singleton: true, requiredVersion: false, import: false },
					'shell/client': { singleton: true, requiredVersion: false, import: false },
				},
			}),
		],
		// No resolve aliases — all shared modules (shell, shared, react)
		// resolve through node_modules (pnpm workspace link) and MF provides
		// the host's singleton at runtime.
		resolve: {},
		// CORS: explicitly allow any origin — the serving host isn't fixed, so no
		// allowlist is possible; declaring it also stops the MF plugin injecting
		// its own wildcard defaults (and warning about it).
		server: { port: 3022, cors: { origin: '*' } },
		source: {
			entry: {
				index: './src/index.ts',
			},
		},
		output: {
			distPath: {
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'apps', 'sql-ui'),
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
