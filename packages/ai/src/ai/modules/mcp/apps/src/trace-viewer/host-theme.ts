/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * rocketride-default.css keys dark mode off [data-theme='dark'] on <html>.
 * MCP Apps hosts don't set that attribute, so mirror the OS/host scheme.
 */
export function applyHostTheme(): void {
	const mq = window.matchMedia('(prefers-color-scheme: dark)');
	const apply = (): void => {
		document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
	};
	apply();
	mq.addEventListener('change', apply);
}
