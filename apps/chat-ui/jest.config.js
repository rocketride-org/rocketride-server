// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Jest configuration for chat-ui unit tests.
 *
 * Uses jsdom so `File` / `Blob` / `crypto.randomUUID` are available — the
 * upload helper relies on browser-side APIs.
 */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'jsdom',
	roots: ['<rootDir>/src'],
	setupFiles: ['<rootDir>/jest.setup.js'],
	testMatch: ['**/*.(test|spec).+(ts|tsx)'],
	transform: {
		'^.+\\.(ts|tsx)$': ['ts-jest', {
			tsconfig: {
				jsx: 'react-jsx',
				esModuleInterop: true,
				module: 'commonjs',
				target: 'ES2020',
				lib: ['ES2020', 'DOM', 'DOM.Iterable'],
				strict: true,
				skipLibCheck: true,
			},
		}],
	},
	moduleNameMapper: {
		'^@/(.*)$': '<rootDir>/src/$1',
		'^@components/(.*)$': '<rootDir>/src/components/$1',
		'^@apptypes/(.*)$': '<rootDir>/src/types/$1',
		'^@utils/(.*)$': '<rootDir>/src/utils/$1',
		'^@hooks/(.*)$': '<rootDir>/src/hooks/$1',
	},
};
