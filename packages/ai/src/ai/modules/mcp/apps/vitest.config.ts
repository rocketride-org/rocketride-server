/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { defineConfig } from 'vitest/config';

import { aliases, canvasStandIns } from './resolve';

// Not the vite.config: that one is WIDGET-env-scoped with a per-widget root.
// The tests share its module resolution (resolve.ts), so a canvas test sees
// the same builder files and stand-ins the canvas bundle does. Tests stay in
// a node environment: they cover pure modules, never a DOM.
export default defineConfig({
	plugins: [canvasStandIns()],
	resolve: {
		alias: aliases,
		dedupe: ['react', 'react-dom', '@xyflow/react'],
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
});
