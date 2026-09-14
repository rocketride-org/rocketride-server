// Pure presentation helpers shared by the docs theme components. Kept as plain
// ESM (no JSX) so Node's test runner can exercise them directly under docs:test.

/**
 * Format a star count into a compact label.
 *
 * Counts under 1000 render verbatim; larger counts collapse to one decimal of
 * thousands with a trailing `k` (and a redundant `.0` trimmed). Past ~1M this
 * yields e.g. `1000k` — acceptable for a repo whose count lives in the low
 * thousands, so there is deliberately no `M` branch.
 *
 * @param {number} count - Raw star count.
 * @returns {string} Compact display string (e.g. `999`, `1.5k`, `12k`).
 */
export function formatStars(count) {
	if (count < 1000) return String(count);
	return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * Map a doc route to its raw `.md` sibling emitted by docs:gather.
 *
 * @param {string} pathname - Current route, e.g. `/` or `/nodes/x/`.
 * @returns {string} Markdown URL, e.g. `/index.md` or `/nodes/x.md`.
 */
export function markdownUrl(pathname) {
	if (pathname === '/') return '/index.md';
	return `${pathname.replace(/\/$/, '')}.md`;
}

/**
 * Whether a footer href points off-site (an absolute http/https URL).
 *
 * @param {string} href - Link target.
 * @returns {boolean} True for absolute external URLs, false for internal routes.
 */
export function isExternal(href) {
	return /^https?:\/\//.test(href);
}
