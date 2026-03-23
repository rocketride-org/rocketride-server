/**
 * Vitest config for dropper-ui React webview tests.
 *
 * Based on Reddit March 2026 best practices:
 * - JSDOM for fast component tests (not browser mode)
 * - vite-tsconfig-paths for alias resolution
 * - React plugin for JSX transform
 * - CSS processing enabled for Tailwind
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
	plugins: [react(), tsconfigPaths()],
	test: {
		globals: true,
		environment: 'jsdom',
		setupFiles: ['./src/test/setup.ts'],
		css: true,
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
	},
});
