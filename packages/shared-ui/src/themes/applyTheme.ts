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
