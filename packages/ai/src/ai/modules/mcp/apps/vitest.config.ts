/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { defineConfig } from 'vitest/config';

// Deliberately NOT the vite.config: that one is WIDGET-env-scoped with a
// per-widget root. Unit tests cover pure modules (no DOM, no aliases).
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
});
