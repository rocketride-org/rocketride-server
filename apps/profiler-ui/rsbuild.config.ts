// =============================================================================
// PROFILER-UI — Module Federation Remote (cProfile Profiler app)
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
