/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * rocketride-default.css keys dark mode off [data-theme='dark'] on <html>.
 * MCP Apps hosts DO report a theme — `McpUiHostContext.theme`, available via
 * `App.getHostContext()` once connected and pushed again on `hostcontextchanged`
 * — so that wins. The OS `prefers-color-scheme` scheme is only the fallback,
 * used before the host has connected/opted in, or if it never supplies a theme.
 */
import { applyDocumentTheme, type App } from '@modelcontextprotocol/ext-apps';

/** Host theme if `app` already knows one, else the current OS scheme. */
function applyCurrent(app: App, mq: MediaQueryList): void {
	const hostTheme = app.getHostContext()?.theme;
	applyDocumentTheme(hostTheme ?? (mq.matches ? 'dark' : 'light'));
}

/**
 * Wires up theme handling for `app`. Call before `app.connect()` so no
 * `hostcontextchanged` notification is missed — `getHostContext()` is safe
 * to read early too (it's simply `undefined` pre-handshake, in which case
 * the OS scheme is used).
 */
export function applyHostTheme(app: App): void {
	const mq = window.matchMedia('(prefers-color-scheme: dark)');

	applyCurrent(app, mq);
	mq.addEventListener('change', () => applyCurrent(app, mq));

	app.addEventListener('hostcontextchanged', (ctx) => {
		applyDocumentTheme(ctx.theme ?? (mq.matches ? 'dark' : 'light'));
	});
}
