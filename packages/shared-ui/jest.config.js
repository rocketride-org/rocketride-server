// =============================================================================
// Jest config for shared-ui src unit tests.
//
// Scope: pure predicates and renderToStaticMarkup output for the trace renderers
// (no DOM — react-dom/server runs under testEnvironment 'node'). The package build
// (rollup, es5) is untouched; ts-jest uses an inline CommonJS/react-jsx override so
// tests require without pulling the es5/esnext build settings.
// =============================================================================

module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/src'],
	testMatch: ['**/__tests__/**/*.+(ts|tsx)', '**/*.(test|spec).+(ts|tsx)'],
	transform: {
		'^.+\\.(ts|tsx)$': [
			'ts-jest',
			{
				tsconfig: {
					jsx: 'react-jsx',
					esModuleInterop: true,
					module: 'commonjs',
					target: 'es2019',
					isolatedModules: true,
				},
			},
		],
	},
};
