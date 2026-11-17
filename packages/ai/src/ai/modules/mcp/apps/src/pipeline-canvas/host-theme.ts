/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Follows the host's light or dark theme and applies the full RocketRide
 * token set for it, so the builder's node components (which paint with
 * --rr-* tokens) match the host. The host's theme wins; the OS scheme is
 * the fallback before the host connects or when it sends none.
 *
 * Same export as the shared helper the other widgets move to; this copy is
 * removed when the canvas switches to that one.
 */
import { applyDocumentTheme, type App } from '@modelcontextprotocol/ext-apps';

import light from 'shell/public/themes/light.json';
import dark from 'shell/public/themes/dark.json';

type Theme = 'light' | 'dark';

/** The widget keeps its own accent (shared/theme.css); every other token follows the theme. */
const KEEP = new Set(['--rr-accent']);

/** The token set for `theme`, without the tokens the widget keeps. */
export function tokensFor(theme: Theme): Record<string, string> {
	const source: Record<string, string> = theme === 'dark' ? dark : light;
	return Object.fromEntries(Object.entries(source).filter(([key]) => !KEEP.has(key)));
}

function apply(theme: Theme): void {
	applyDocumentTheme(theme);
	const style = document.documentElement.style;
	for (const [key, value] of Object.entries(tokensFor(theme))) style.setProperty(key, value);
}

function current(app: App, mq: MediaQueryList): Theme {
	return app.getHostContext()?.theme ?? (mq.matches ? 'dark' : 'light');
}

/**
 * Wires up theme handling for `app`. Call before `app.connect()` so no
 * `hostcontextchanged` notification is missed. Call `syncHostTheme` once
 * the handshake resolves, since `getHostContext()` is only set then.
 */
export function applyHostTheme(app: App): void {
	const mq = window.matchMedia('(prefers-color-scheme: dark)');
	apply(current(app, mq));
	mq.addEventListener('change', () => apply(current(app, mq)));
	app.addEventListener('hostcontextchanged', (ctx) => {
		apply(ctx.theme ?? current(app, mq));
	});
}

/** Re-applies the host theme after `app.connect()` resolves. */
export function syncHostTheme(app: App): void {
	const mq = window.matchMedia('(prefers-color-scheme: dark)');
	apply(current(app, mq));
}
