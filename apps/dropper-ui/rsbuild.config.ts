/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { defineConfig, loadEnv } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';

export default defineConfig(({ command }) => {
	const isDev = command === 'dev';
	const { parsed } = loadEnv({ prefixes: ['ROCKETRIDE_'] });

	if (isDev && !process.env.ROCKETRIDE_APIKEY) {
		throw new Error('ROCKETRIDE_APIKEY environment variable is required to start the dev server');
	}

	return {
		server: {
			port: 3003,
			base: '/dropper/'
		},
		plugins: [
			pluginReact(),
			pluginTypeCheck()
		],

		html: {
			template: './src/index.html',
			title: 'RocketRide AI Dropper',
			favicon: './public/favicon.ico',
			meta: {
				description: 'RocketRide AI Dropper - Intelligent data governance viewer',
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
			assetPrefix: '/dropper/'
		},

		output: {
			distPath: {
				root: '../../build/dropper-ui'
			},
			assetPrefix: '/dropper/',
			cleanDistPath: true,
			sourceMap: {
				js: 'source-map',
				css: true
			}
		}
	};
});
