import { defineConfig, loadEnv } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';
import path from 'path';

export default defineConfig(({ command }) => {
	const isDev = command === 'dev';
	const { parsed } = loadEnv({ prefixes: ['ROCKETRIDE_'] });

	if (isDev && !process.env.ROCKETRIDE_APIKEY) {
		throw new Error('ROCKETRIDE_APIKEY environment variable is required to start the dev server');
	}

	return {
		server: {
			port: 3002,
			base: '/chat/'
		},
		plugins: [
			pluginReact(),
			pluginTypeCheck()
		],

		html: {
			template: './src/index.html',
			title: 'RocketRide AI Assistant',
			favicon: './public/favicon.ico',
			meta: {
				description: 'RocketRide AI Assistant - Intelligent chatbot',
				'theme-color': '#FF8C42',
				viewport: 'width=device-width, initial-scale=1.0'
			}
		},

		source: {
			entry: {
				index: './src/index.tsx'
			},
			define: {
				...(isDev ? {
					'process.env.CONFIG': JSON.stringify({
						...parsed,
						devMode: true
					})
				} : {
					'process.env.CONFIG': JSON.stringify({
						...parsed,
						devMode: false
					})
				})
			}
		},

		dev: {
			writeToDisk: true,
			assetPrefix: '/chat/'
		},

		output: {
			distPath: {
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'chat-ui')
			},
			assetPrefix: '/chat/',
			cleanDistPath: true,
			sourceMap: {
				js: isDev ? 'source-map' : false,
				css: isDev
			}
		}
	};
});
