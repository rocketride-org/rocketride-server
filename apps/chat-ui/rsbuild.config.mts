/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

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
	// NO server address is ever baked — the app self-targets from
	// window.location.origin (the dev server proxies the engine so that
	// holds in dev too). Dev builds additionally carry the dev API key
	// (auth bypass); production bundles carry nothing.
	const clientEnvKeys = isDev ? ['ROCKETRIDE_APIKEY'] : [];
	const parsed = Object.fromEntries(clientEnvKeys.flatMap((k) => (fullEnv[k] ? [[k, fullEnv[k]]] : [])));

	if (isDev) {
		requireKeys(parsed, ['ROCKETRIDE_APIKEY'], 'chat-ui');
	}

	return {
		// Treat .pipe files as JSON so pipeline definitions can be imported.
		// `as const` keeps the rule's `type` a literal for the config typecheck.
		tools: {
			rspack: {
				module: {
					rules: [{ test: /\.pipe$/, type: 'json' } as const],
				},
			},
		},
		server: {
			port: 3002,
			base: '/chat/',
			// Relay the engine's DAP WebSocket so window.location.origin is
			// the server in dev exactly as it is when engine-served.
			...(isDev && {
				proxy: {
					'/task': { target: 'http://localhost:5565', ws: true },
				},
			}),
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
				'process.env.CONFIG': JSON.stringify({
					...parsed,
					devMode: isDev,
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
