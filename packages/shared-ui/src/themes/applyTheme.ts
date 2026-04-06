// =============================================================================
// Theme Application
// =============================================================================

import type { ThemeTokens } from './tokens';

/**
 * Apply a theme by setting all --rr-* CSS custom properties on :root.
 * Works in any document context (main app, iframe, webview).
 */
export function applyTheme(tokens: ThemeTokens): void {
	const root = document.documentElement;
	for (const [key, value] of Object.entries(tokens)) {
		root.style.setProperty(key, value);
	}
}

/**
 * Read current --rr-* token values from the document root.
 * Useful for forwarding the active theme to iframes.
 */
export function readTheme(): Record<string, string> {
	const style = getComputedStyle(document.documentElement);
	const tokens: Record<string, string> = {};
	for (let i = 0; i < document.documentElement.style.length; i++) {
		const prop = document.documentElement.style[i];
		if (prop.startsWith('--rr-')) {
			tokens[prop] = style.getPropertyValue(prop).trim();
		}
	}
	return tokens;
}

/**
 * Fetch a theme JSON file from the server and apply it.
 * Returns the token object so callers can pass it to iframes or buildMuiTheme.
 */
export async function fetchAndApplyTheme(themeId: string): Promise<ThemeTokens> {
	const response = await fetch(`/themes/${themeId}.json`);
	if (!response.ok) throw new Error(`Theme '${themeId}' not found`);
	const tokens: ThemeTokens = await response.json();
	applyTheme(tokens);
	return tokens;
}
