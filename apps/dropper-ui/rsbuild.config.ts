/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';
import path from 'path';

const { getenv, requireKeys } = require('../../scripts/lib/getenv');

export default defineConfig(({ command }) => {
	const isDev = command === 'dev';
	const fullEnv = getenv();
	const parsed = Object.fromEntries(Object.entries(fullEnv).filter(([k]) => k.startsWith('ROCKETRIDE_')));

	requireKeys(parsed, ['ROCKETRIDE_URI'], 'dropper-ui');
	if (isDev) {
		requireKeys(parsed, ['ROCKETRIDE_APIKEY'], 'dropper-ui');
	}

	return {
		server: {
			port: 3003,
			base: '/dropper/',
		},
		plugins: [pluginReact(), pluginTypeCheck()],

		html: {
			template: './src/index.html',
			title: 'RocketRide AI Dropper',
			favicon: './public/favicon.ico',
			meta: {
				description: 'RocketRide AI Dropper - Intelligent data governance viewer',
				'theme-color': '#FF8C42',
				viewport: 'width=device-width, initial-scale=1.0',
			},
		},

		source: {
			entry: {
				index: './src/index.tsx',
			},
			define: {
				'process.env.CONFIG': JSON.stringify({
					...parsed,
					devMode: isDev,
				}),
			},
		},

		dev: {
			writeToDisk: true,
			assetPrefix: '/dropper/',
		},

		output: {
			distPath: {
				root: path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'dropper-ui'),
			},
			assetPrefix: '/dropper/',
			cleanDistPath: true,
			sourceMap: {
				js: isDev ? 'source-map' : false,
				css: isDev,
			},
		},
	};
});
