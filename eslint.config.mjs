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
        ignores: [
            '**/dist/**',
            '**/build/**',
            '**/node_modules/**',
            '**/*.min.js',
            '**/coverage/**',
            '**/.storybook/**',
            '**/storybook-static/**',
            'apps/vscode/rocketride.js'
        ]
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
            'react-refresh': reactRefreshPlugin
        },
        languageOptions: {
            parserOptions: {
                ecmaFeatures: {
                    jsx: true
                }
            },
            globals: {
                ...globals.browser
            }
        },
        settings: {
            react: {
                version: 'detect'
            }
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
            'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
        }
    },

    // TypeScript-specific rules
    {
        files: ['**/*.{ts,tsx}'],
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { 
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_'
            }],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-require-imports': 'off'
        }
    },

    // Node.js scripts
    {
        files: ['scripts/**/*.js', '**/scripts/**/*.js', '**/esbuild.js'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_'
            }],
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_'
            }]
        }
    },

    // Test files
    {
        files: ['**/*.test.{ts,tsx,js,jsx}', '**/*.spec.{ts,tsx,js,jsx}', '**/test/**/*'],
        languageOptions: {
            globals: {
                ...globals.jest
            }
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off'
        }
    },

    // Prettier compatibility (must be last)
    prettierConfig
);

