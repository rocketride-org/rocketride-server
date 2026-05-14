// =============================================================================
// HELLO-UI — Module Federation Remote (OSS landing page)
// =============================================================================
// Builds remoteEntry.js + AppDescriptor chunk only.
// NOT a standalone app. Run shell-ui:dev for development.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

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
				shared: {
					react: { singleton: true, requiredVersion: '^18.2.0' },
					'react-dom': { singleton: true, requiredVersion: '^18.2.0' },
					// import: false tells MF to NOT bundle a fallback copy —
					// the host (shell-ui) always provides these at runtime.
					// Without this, MF bundles the entire shared-ui tree
					// (fonts, Chart.js, MUI) as a "just in case" fallback.
					'shell-ui': { singleton: true, requiredVersion: false, import: false },
					'shared':   { singleton: true, requiredVersion: false, import: false },
				},
			}),
		],
		// No resolve aliases — all shared modules (shell-ui, shared, react)
		// resolve through node_modules (pnpm workspace link) and MF provides
		// the host's singleton at runtime. This prevents bundling duplicate
		// fonts/CSS from shared-ui into each remote app.
		resolve: {},
		server: { port: 3013 },
		source: {
			entry: {
				index: './src/index.ts',
			},
		},
		output: {
			distPath: {
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'apps', 'hello-ui'),
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
