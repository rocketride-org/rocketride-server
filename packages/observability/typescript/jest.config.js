/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
 */

module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/tests'],
	testMatch: [
		'**/*.(test|spec).+(ts|tsx|js)'
	],
	transform: {
		'^.+\\.(ts|tsx)$': ['ts-jest', {
			useESM: true,
			tsconfig: 'tsconfig.json'
		}],
	},
	testTimeout: 10000,
	verbose: true,
};
