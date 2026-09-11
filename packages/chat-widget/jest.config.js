/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// jest.config.js
//
// Mirrors packages/client-typescript/jest.config.js, but runs in a jsdom
// environment because the chat widget is a browser-only web component
// (shadow DOM, custom elements, keyboard events).

module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'jsdom', // Browser-like environment for web-component/DOM tests
	testRunner: 'jest-jasmine2', // Required for jestreport.js
	roots: ['<rootDir>/tests'],
	testMatch: [
		'**/__tests__/**/*.+(ts|tsx|js)',
		'**/*.(test|spec).+(ts|tsx|js)'
	],
	transform: {
		'^.+\\.(ts|tsx)$': ['ts-jest', {
			tsconfig: 'tsconfig.test.json'
		}],
	},
	setupFilesAfterEnv: ['../../scripts/lib/jestreport.js'],
	collectCoverageFrom: [
		'src/**/*.{ts,tsx}',
		'!src/**/*.d.ts',
		'!src/**/*.test.{ts,tsx}',
	],
	coverageDirectory: 'coverage',
	coverageReporters: ['text', 'lcov', 'html'],
	testTimeout: 30000,
	verbose: true,

	// Force Jest to exit after all tests complete even if there are still
	// open handles. This prevents the test runner from hanging indefinitely.
	forceExit: true,

	// Module name mapping for cleaner imports
	// - Resolve ESM-style relative .js imports to TypeScript source files
	// - Resolve the workspace 'rocketride' SDK to its TypeScript source so the
	//   suite never depends on a pre-built dist/ (tests mock src/connection.ts,
	//   so the SDK is only needed for type resolution).
	moduleNameMapper: {
		'^(\\.\\.?/.*)\\.js$': '$1',
		'^rocketride$': '<rootDir>/../client-typescript/src/client/index.ts',
	}
};
