import { createRequire } from 'node:module';
import path from 'path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';

const require = createRequire(import.meta.url);
const { getenv, requireKeys } = require('../../scripts/lib/getenv');

export default defineConfig(({ command }) => {
	const isDev = command === 'dev';
	const fullEnv = getenv();
	// Allowlist: only bundle public client-safe ROCKETRIDE_* vars
	const clientEnvKeys = ['ROCKETRIDE_URI', ...(isDev ? ['ROCKETRIDE_APIKEY'] : [])];
	const parsed = Object.fromEntries(clientEnvKeys.flatMap((k) => (fullEnv[k] ? [[k, fullEnv[k]]] : [])));

	requireKeys(parsed, ['ROCKETRIDE_URI'], 'chat-ui');
	if (isDev) {
		requireKeys(parsed, ['ROCKETRIDE_APIKEY'], 'chat-ui');
	}

	return {
		server: {
			port: 3002,
			base: '/chat/',
		},
		plugins: [pluginReact(), pluginTypeCheck()],

		html: {
			template: './src/index.html',
			title: 'RocketRide AI Assistant',
			favicon: './public/favicon.ico',
			meta: {
				description: 'RocketRide AI Assistant - Intelligent chatbot',
				'theme-color': '#FF8C42',
				viewport: 'width=device-width, initial-scale=1.0',
			},
		},

		source: {
			entry: {
				index: './src/index.tsx',
			},
			define: {
				...(isDev
					? {
							'process.env.CONFIG': JSON.stringify({
								...parsed,
								devMode: true,
							}),
						}
					: {
							'process.env.CONFIG': JSON.stringify({
								...parsed,
								devMode: false,
							}),
						}),
			},
		},

		dev: {
			writeToDisk: true,
			assetPrefix: '/chat/',
		},

		output: {
			distPath: {
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'chat-ui'),
			},
			assetPrefix: '/chat/',
			cleanDistPath: true,
			sourceMap: {
				js: isDev ? 'source-map' : false,
				css: isDev,
			},
		},
	};
});
