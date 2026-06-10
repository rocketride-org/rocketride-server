// =============================================================================
// Theme Application
// =============================================================================

import type { ThemeTokens } from './tokens';

/** Last-applied tokens — used by readTheme() instead of fragile DOM iteration. */
let _cachedTokens: ThemeTokens = {};

/**
 * Apply a theme by setting all --rr-* CSS custom properties on :root.
 * Works in any document context (main app, iframe, webview).
 */
export function applyTheme(tokens: ThemeTokens): void {
	_cachedTokens = { ...tokens };
	const root = document.documentElement;
	for (const [key, value] of Object.entries(tokens)) {
		root.style.setProperty(key, value);
	}
}

/**
 * Read current theme tokens. Returns the cached copy from the last
 * applyTheme() call — avoids brittle DOM style iteration.
 */
export function readTheme(): ThemeTokens {
	return { ..._cachedTokens };
}

/**
 * Fetch a theme JSON file from the server and apply it.
 * Returns the token object so callers can pass it to iframes or buildMuiTheme.
 * @param themeId  Theme file name without extension (e.g. 'rocketride-light')
 * @param basePath URL prefix where theme files are hosted (default: '/themes')
 */
/**
 * Per-theme token cache. After the first fetch, repeated switches to the same
 * theme apply from memory instead of re-fetching the JSON over the network —
 * the round-trip jitter was what made the switch-to-light flash intermittent.
 */
const _themeFetchCache = new Map<string, ThemeTokens>();

// Tokens originate from JSON, so a JSON round-trip is a safe, complete deep
// clone. We hand every caller its own copy and keep an independent copy in the
// cache, so a caller mutating its tokens can never corrupt a future theme apply.
const cloneTokens = (tokens: ThemeTokens): ThemeTokens => JSON.parse(JSON.stringify(tokens));

export async function fetchAndApplyTheme(themeId: string, basePath = '/themes'): Promise<ThemeTokens> {
	const cacheKey = `${basePath}/${themeId}`;
	const cached = _themeFetchCache.get(cacheKey);
	if (cached) { const copy = cloneTokens(cached); applyTheme(copy); return copy; }
	const response = await fetch(`${basePath}/${themeId}.json`);
	if (!response.ok) throw new Error(`Theme '${themeId}' not found`);
	const tokens: ThemeTokens = await response.json();
	// Cache a private clone; the fresh `tokens` object is returned to the caller.
	_themeFetchCache.set(cacheKey, cloneTokens(tokens));
	applyTheme(tokens);
	return tokens;
}
