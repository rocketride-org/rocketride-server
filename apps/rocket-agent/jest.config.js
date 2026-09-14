module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	testRunner: 'jest-jasmine2',
	roots: ['<rootDir>/tests'],
	testMatch: ['**/*.(test|spec).+(ts|tsx|js)'],
	transform: { '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
	setupFilesAfterEnv: ['../../scripts/lib/jestreport.js'],
	testTimeout: 120000,
	forceExit: true,
};
