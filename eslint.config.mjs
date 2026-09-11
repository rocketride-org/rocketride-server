import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactRefreshPlugin from 'eslint-plugin-react-refresh';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
	// Global ignores
	{
		ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.min.js', '**/coverage/**', '**/.storybook/**', '**/storybook-static/**', 'apps/vscode/rocketride.js', 'packages/n8n-nodes/**'],
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

	// Prettier compatibility (must be last)
	prettierConfig
);
