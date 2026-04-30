import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';
import path from 'path';

const { getenv, requireKeys } = require('../../scripts/lib/getenv');

export default defineConfig(({ command }) => {
	const isDev = command === 'dev';
	const fullEnv = getenv();
	const parsed = Object.fromEntries(Object.entries(fullEnv).filter(([k]) => k.startsWith('ROCKETRIDE_')));

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
