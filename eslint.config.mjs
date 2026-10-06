import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactRefreshPlugin from 'eslint-plugin-react-refresh';
import nodePlugin from 'eslint-plugin-n';
import stylistic from '@stylistic/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

// Build scripts: the builder (scripts/) and every module's scripts/ tree that
// it discovers tasks.js in. Must stay in sync with tsconfig.scripts.json,
// which backs the type-aware rules below.
const BUILD_SCRIPTS = ['**/scripts/**/*.{js,cjs,mjs}'];

export default tseslint.config(
	// Global ignores
	{
		// scripts/assets/ holds files packaged as-is (the shell stub), not build code
		ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.min.js', '**/coverage/**', '**/.storybook/**', '**/storybook-static/**', 'apps/vscode/rocketride.js', 'packages/n8n-nodes/**', 'scripts/assets/**'],
	},

	// Base config for all files
	js.configs.recommended,

	// TypeScript files
	...tseslint.configs.recommended,

	// React configuration for JSX/TSX files
	{
		files: ['**/*.{jsx,tsx}'],
		plugins: {
			react: reactPlugin,
			'react-hooks': reactHooksPlugin,
			'react-refresh': reactRefreshPlugin,
		},
		languageOptions: {
			parserOptions: {
				ecmaFeatures: {
					jsx: true,
				},
			},
			globals: {
				...globals.browser,
			},
		},
		settings: {
			react: {
				version: 'detect',
			},
		},
		rules: {
			// React rules
			'react/react-in-jsx-scope': 'off', // Not needed with React 17+
			'react/prop-types': 'off', // Using TypeScript
			'react/display-name': 'off',

			// React Hooks rules
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',

			// React Refresh rules
			'react-refresh/only-export-components': 'off',
		},
	},

	// TypeScript-specific rules
	{
		files: ['**/*.{ts,tsx}'],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-empty-object-type': 'off',
			'@typescript-eslint/no-require-imports': 'off',
		},
	},

	// Node.js scripts
	{
		files: ['scripts/**/*.{js,mjs,cjs}', '**/scripts/**/*.{js,mjs,cjs}', '**/esbuild.js'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
			'no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
		},
	},

	// Build scripts — stricter than the block above: mistakes here break the
	// build for everyone, and the worst ones (an un-awaited step, a require
	// that no longer resolves) pass silently until they don't.
	// No package with a scripts/ tree sets "type": "module", so .js is CommonJS.
	{
		files: ['**/scripts/**/*.js'],
		languageOptions: {
			sourceType: 'commonjs',
		},
	},
	{
		files: BUILD_SCRIPTS,
		plugins: {
			n: nodePlugin,
		},
		languageOptions: {
			ecmaVersion: 2022,
			parserOptions: {
				project: './tsconfig.scripts.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Async steps: a promise nobody awaits lets the next step start
			// before this one finishes
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/await-thenable': 'error',

			// Module resolution and Node APIs. Not no-extraneous-*: build scripts
			// run under the root package, so its devDependencies (glob, dotenv,
			// typescript) are theirs whatever the nearest package.json declares.
			// For the same reason the Node version is the root engines range,
			// not each package's own.
			'n/no-missing-require': 'error',
			'n/no-missing-import': 'error',
			'n/no-unsupported-features/node-builtins': ['error', { version: '>=20.0.0', allowExperimental: true }],
			'n/no-deprecated-api': 'error',

			// Plain JS: the core rule, not the TypeScript one
			'@typescript-eslint/no-unused-vars': 'off',
			'no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrors: 'none',
				},
			],
			// `const crypto = require('crypto')` is not a redeclaration worth flagging
			'no-redeclare': ['error', { builtinGlobals: false }],
			'no-empty': ['error', { allowEmptyCatch: true }],
			eqeqeq: ['error', 'smart'],
			'prefer-const': 'error',
		},
	},
	// node:test registers test()/describe() without awaiting them
	{
		files: ['**/scripts/**/*.test.{js,cjs,mjs}'],
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
		},
	},

	// CommonJS files — Node dialect wherever they live: require(), process,
	// timers. The dev-server guard ships as a real .cjs beside the extension
	// bundle (spawned as a file, it cannot live inside it), outside every
	// scripts/ tree the block above matches.
	{
		files: ['**/*.cjs'],
		languageOptions: {
			sourceType: 'commonjs',
			globals: {
				...globals.node,
			},
		},
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
		},
	},

	// Test files
	{
		files: ['**/*.test.{ts,tsx,js,jsx}', '**/*.spec.{ts,tsx,js,jsx}', '**/test/**/*'],
		languageOptions: {
			globals: {
				...globals.jest,
			},
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},

	// =========================================================================
	// SHELL-UNIFICATION IMPORT CONTRACT
	// =========================================================================
	// Two legal import forms, declared by the specifier itself:
	//   Form 1 - bare 'shell':      runtime-bound platform surface (barrel-only)
	//   Form 2 - 'shared/<group>':  statically bundled library (deep specs only)
	// The bare 'shared' root barrel and the old 'shell-ui' name do not exist.
	{
		files: ['**/*.{ts,tsx,mts}'],
		rules: {
			'no-restricted-imports': ['error', {
				paths: [
					{ name: 'shared', message: "The shared root barrel is retired. Surface symbols come from 'shell'; library components use deep 'shared/<group>' specs." },
					{ name: 'shell-ui', message: "Renamed: import from 'shell'." },
				],
				patterns: [
					// The SDK surface lives in the 'rocketride' package now; the
					// shell exposes no subpaths besides the theme stylesheet.
					{ group: ['shell/*'], message: "The shell surface is barrel-only: import the name from 'shell' (SDK values/types come from 'rocketride')." },
					{ group: ['shell-ui/*'], message: "Renamed: import from 'shell'." },
				],
			}],
		},
	},
	// The shell package itself: NO 'shell' barrel. Inside the shell it is a
	// boot-order hazard (self-import resolves through the MF share scope
	// before the factory registers). Use relative imports / deep shared specs.
	{
		files: ['packages/shell/**/*.{ts,tsx,mts}'],
		rules: {
			'no-restricted-imports': ['error', {
				paths: [
					{ name: 'shell', message: "No 'shell' barrel here: use relative imports (shell package)." },
					{ name: 'shared', message: "The shared root barrel is retired: use deep 'shared/<group>' specs." },
					{ name: 'shell-ui', message: "Renamed package: use relative imports." },
				],
				patterns: [
					// The in-tree STATIC path form is legal here: bundled component copies are
					// bundled copies (no self-barrel in shell).
					{ group: ['shell/*', '!shell/src/*'], message: "Only shell package sources are deep-importable in-tree (shell/src/<group>); everything else is relative (in-package) or the barrel (elsewhere)." },
				],
			}],
		},
	},

	// The vscode extension consumes the INSTALLED shell package (shell.tgz)
	// like any workspace app, so the barrel is the legal form here - along
	// with the one exported theme stylesheet subpath.
	{
		files: ['apps/vscode/**/*.{ts,tsx,mts}'],
		rules: {
			'no-restricted-imports': ['error', {
				paths: [
					{ name: 'shared', message: "The shared root barrel is retired: use deep 'shared/<group>' specs." },
					{ name: 'shell-ui', message: "Renamed: import from 'shell'." },
				],
				patterns: [
					// gitignore semantics: a file under an excluded dir cannot be
					// re-included, so un-ignore shell/themes first, then re-ban its
					// contents except the one exported stylesheet.
					{ group: ['shell/*', '!shell/themes', 'shell/themes/*', '!shell/themes/rocketride-default.css'], message: "The shell surface is barrel-only: import the name from 'shell' (the theme stylesheet is the one exported subpath; SDK values/types come from 'rocketride')." },
				],
			}],
		},
	},

	// shared (the static library): imports the surface from 'shell' (Form 1)
	// and non-surface stock internals via the in-tree path form.
	{
		files: ['apps/shared/**/*.{ts,tsx,mts}'],
		rules: {
			'no-restricted-imports': ['error', {
				paths: [
					{ name: 'shared', message: "The shared root barrel is retired: use relative imports inside the library." },
					{ name: 'shell-ui', message: "Renamed: import from 'shell'." },
				],
				patterns: [
					{ group: ['shell/*', '!shell/src/*'], message: "Only shell package sources are deep-importable in-tree (shell/src/<group>)." },
				],
			}],
		},
	},

	// Prettier compatibility (must be last, apart from re-enabled rules below)
	prettierConfig,

	// Build scripts: 120 columns. After prettierConfig, which turns length
	// rules off; Prettier wraps code to the same width (.prettierrc override),
	// this catches what it cannot wrap — strings, template literals, comments.
	{
		files: BUILD_SCRIPTS,
		plugins: {
			'@stylistic': stylistic,
		},
		rules: {
			'@stylistic/max-len': ['error', { code: 120, tabWidth: 4, ignoreUrls: true, ignoreRegExpLiterals: true }],
		},
	}
);
