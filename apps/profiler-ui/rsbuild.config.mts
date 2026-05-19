// =============================================================================
// PROFILER-UI — Module Federation Remote (cProfile Profiler app)
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
					// import: false — host always provides these, no fallback needed.
					'shell-ui': { singleton: true, requiredVersion: false, import: false },
					'shared':   { singleton: true, requiredVersion: false, import: false },
				},
			}),
		],
		resolve: {},
		server: { port: 3017 },
		source: {
			entry: {
				index: './src/index.ts',
			},
		},
		output: {
			distPath: {
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'apps', 'profiler-ui'),
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
