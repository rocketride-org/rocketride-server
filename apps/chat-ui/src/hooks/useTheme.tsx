/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
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

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useVSCode } from './useVSCode';

export type ThemeName = 'ocean' | 'forest' | 'sunset' | 'midnight' | 'corporate' | 'vscode';

interface ThemeColors {
	[key: string]: string;
}

interface ThemeContextType {
	currentTheme: ThemeName;
	setTheme: (theme: ThemeName) => void;
	isVSCode: boolean;
	mode: 'standalone' | 'vscode';
	availableThemes: ThemeName[];
}

const THEMES: Record<ThemeName, ThemeColors> = {
	corporate: {
		'bg-primary': '#ffffff',
		'bg-secondary': '#f5f5f5',
		'bg-tertiary': '#e5e5e5',
		'bg-hover': '#d5d5d5',
		'text-primary': '#1a1a1a',
		'text-secondary': '#4a4a4a',
		'text-muted': '#7a7a7a',
		'border-color': '#d5d5d5',
		'border-hover': '#c5c5c5',
		'accent-primary': '#FF8C42',
		'accent-secondary': '#E67A2E',
		'accent-hover': '#FFA366',
		'success-color': '#10b981',
		'error-color': '#ef4444',
		'warning-color': '#f59e0b',
		'info-color': '#3b82f6',
		'code-bg': '#f5f5f5',
		'input-bg': '#ffffff',
		'input-border': '#d5d5d5',
	},
	ocean: {
		'bg-primary': '#0f172a',
		'bg-secondary': '#1e293b',
		'bg-tertiary': '#334155',
		'bg-hover': '#475569',
		'text-primary': '#f1f5f9',
		'text-secondary': '#94a3b8',
		'text-muted': '#64748b',
		'border-color': '#334155',
		'border-hover': '#475569',
		'accent-primary': '#0ea5e9',
		'accent-secondary': '#06b6d4',
		'accent-hover': '#38bdf8',
		'success-color': '#10b981',
		'error-color': '#ef4444',
		'warning-color': '#f59e0b',
		'info-color': '#3b82f6',
		'code-bg': '#1e293b',
		'input-bg': '#1e293b',
		'input-border': '#334155',
	},
	forest: {
		'bg-primary': '#0a1f0a',
		'bg-secondary': '#1a2f1a',
		'bg-tertiary': '#2a4f2a',
		'bg-hover': '#3a5f3a',
		'text-primary': '#e8f5e8',
		'text-secondary': '#b8d5b8',
		'text-muted': '#88a588',
		'border-color': '#2a4f2a',
		'border-hover': '#3a5f3a',
		'accent-primary': '#10b981',
		'accent-secondary': '#059669',
		'accent-hover': '#34d399',
		'success-color': '#10b981',
		'error-color': '#ef4444',
		'warning-color': '#f59e0b',
		'info-color': '#3b82f6',
		'code-bg': '#1a2f1a',
		'input-bg': '#1a2f1a',
		'input-border': '#2a4f2a',
	},
	sunset: {
		'bg-primary': '#1f0a0a',
		'bg-secondary': '#2f1a1a',
		'bg-tertiary': '#4f2a2a',
		'bg-hover': '#5f3a3a',
		'text-primary': '#f5e8e8',
		'text-secondary': '#d5b8b8',
		'text-muted': '#a58888',
		'border-color': '#4f2a2a',
		'border-hover': '#5f3a3a',
		'accent-primary': '#f97316',
		'accent-secondary': '#ea580c',
		'accent-hover': '#fb923c',
		'success-color': '#10b981',
		'error-color': '#ef4444',
		'warning-color': '#f59e0b',
		'info-color': '#3b82f6',
		'code-bg': '#2f1a1a',
		'input-bg': '#2f1a1a',
		'input-border': '#4f2a2a',
	},
	midnight: {
		'bg-primary': '#000000',
		'bg-secondary': '#1a1a1a',
		'bg-tertiary': '#2a2a2a',
		'bg-hover': '#3a3a3a',
		'text-primary': '#ffffff',
		'text-secondary': '#b8b8b8',
		'text-muted': '#888888',
		'border-color': '#2a2a2a',
		'border-hover': '#3a3a3a',
		'accent-primary': '#8b5cf6',
		'accent-secondary': '#7c3aed',
		'accent-hover': '#a78bfa',
		'success-color': '#10b981',
		'error-color': '#ef4444',
		'warning-color': '#f59e0b',
		'info-color': '#3b82f6',
		'code-bg': '#1a1a1a',
		'input-bg': '#1a1a1a',
		'input-border': '#2a2a2a',
	},
	vscode: {
		'bg-primary': '#1e1e1e',
		'bg-secondary': '#252526',
		'bg-tertiary': '#2d2d30',
		'bg-hover': '#3e3e42',
		'text-primary': '#cccccc',
		'text-secondary': '#9d9d9d',
		'text-muted': '#6e6e6e',
		'border-color': '#3e3e42',
		'border-hover': '#4e4e52',
		'accent-primary': '#007acc',
		'accent-secondary': '#005a9e',
		'accent-hover': '#1e8ad6',
		'success-color': '#89d185',
		'error-color': '#f48771',
		'warning-color': '#cca700',
		'info-color': '#75beff',
		'code-bg': '#1e1e1e',
		'input-bg': '#3c3c3c',
		'input-border': '#3e3e42',
	},
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error('useTheme must be used within ThemeProvider');
	}
	return context;
};

interface ThemeProviderProps {
	children: ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
	const { isVSCode, theme: vscodeTheme } = useVSCode();

	const [currentTheme, setCurrentTheme] = useState<ThemeName>(
		isVSCode ? 'vscode' : 'ocean'
	);

	const mode: 'standalone' | 'vscode' = isVSCode ? 'vscode' : 'standalone';
	const availableThemes: ThemeName[] = isVSCode
		? ['vscode']
		: ['ocean', 'forest', 'sunset', 'midnight', 'corporate'];

	// Apply theme colors to CSS variables
	useEffect(() => {
		// In VSCode mode, don't apply any theme until we have the vscodeTheme
		if (isVSCode && !vscodeTheme) {
			return;
		}

		const root = document.documentElement;

		// Determine which colors to use
		let colors: ThemeColors;
		if (isVSCode && vscodeTheme) {
			colors = vscodeTheme;
		} else {
			colors = THEMES[currentTheme];
		}

		// Apply colors as CSS variables
		Object.entries(colors).forEach(([key, value]) => {
			// If key already has --, use it as is, otherwise add --
			const cssVarName = key.startsWith('--') ? key : `--${key}`;
			root.style.setProperty(cssVarName, value);
		});

	}, [currentTheme, vscodeTheme, isVSCode]);

	const setTheme = (theme: ThemeName) => {
		// Only allow theme switching in standalone mode
		if (!isVSCode) {
			setCurrentTheme(theme);
		}
	};

	return (
		<ThemeContext.Provider value={{
			currentTheme: isVSCode ? 'vscode' : currentTheme,
			setTheme,
			isVSCode,
			mode,
			availableThemes
		}}>
			{children}
		</ThemeContext.Provider>
	);
};
