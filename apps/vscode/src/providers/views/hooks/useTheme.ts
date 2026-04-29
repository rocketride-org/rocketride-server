// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useTheme — detects the current VS Code theme (dark/light/high-contrast).
 *
 * VS Code webviews don't use the OS `prefers-color-scheme` media query.
 * Instead, the theme is signaled via CSS classes on `document.body`:
 *   - `vscode-dark`
 *   - `vscode-light`
 *   - `vscode-high-contrast`
 *   - `vscode-high-contrast-light`
 *
 * This hook watches for class changes and returns the current state.
 */

import { useState, useEffect } from 'react';

export type VscodeTheme = 'dark' | 'light';

function detectTheme(): VscodeTheme {
	const cl = document.body.classList;
	if (cl.contains('vscode-dark') || cl.contains('vscode-high-contrast')) {
		return 'dark';
	}
	return 'light';
}

/**
 * Returns `'dark'` or `'light'` based on the active VS Code theme.
 * Updates automatically when the user switches themes.
 */
export function useTheme(): VscodeTheme {
	const [theme, setTheme] = useState<VscodeTheme>(detectTheme);

	useEffect(() => {
		const observer = new MutationObserver(() => setTheme(detectTheme()));
		observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	}, []);

	return theme;
}
