/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Every widget follows the host's light or dark theme. MCP Apps hosts report
 * it as `McpUiHostContext.theme`: in the `ui/initialize` reply and again on
 * `hostcontextchanged`. The OS `prefers-color-scheme` is only the fallback,
 * used before the handshake or when a host never sends a theme.
 *
 * Applying a theme does two things: it sets `data-theme` and `color-scheme`
 * on <html> (what rocketride-default.css and the widgets' CSS key off), and it
 * sets the full RocketRide token set for that theme (the --rr-* values the
 * shell app uses, from packages/shell/public/themes). A widget cannot fetch
 * those files, so they are bundled.
 */
import { applyDocumentTheme, type App } from '@modelcontextprotocol/ext-apps';

import darkTokens from '../../../../../../../../shell/public/themes/dark.json';
import lightTokens from '../../../../../../../../shell/public/themes/light.json';

export type Theme = 'light' | 'dark';

/**
 * Widget-only adjustments. The trace viewer's shared components draw labels,
 * values and lane badges with these tokens at 10-13 px, where the app's values
 * fall short of WCAG AA contrast (4.5:1, badges on their own tint) in a chat
 * column. --rr-brand follows the widget accent's text shade, so values and
 * buttons share one blue. The font is the system face the other widgets and
 * the host use, not the app's Roboto.
 */
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const OVERRIDES: Record<Theme, Record<string, string>> = {
	light: {
		'--rr-font-family': FONT,
		'--rr-text-disabled': '#6b6b6b',
		'--rr-brand': '#0b6f9c',
		'--rr-color-success': '#1e7e45',
		'--rr-chart-blue': '#2f4ac0',
		'--rr-chart-green': '#1f6b30',
		'--rr-chart-yellow': '#7a5c00',
		'--rr-chart-purple': '#6b3fc0',
		'--rr-chart-orange': '#9c4a00',
		'--rr-chart-red': '#a51d1d',
	},
	dark: {
		'--rr-font-family': FONT,
		'--rr-text-disabled': '#a0a0a0',
		'--rr-brand': '#41b6e6',
		'--rr-color-success': '#69db7c',
		'--rr-chart-blue': '#91a7ff',
	},
};

const TOKENS: Record<Theme, Record<string, string>> = {
	light: { ...lightTokens, ...OVERRIDES.light },
	dark: { ...darkTokens, ...OVERRIDES.dark },
};

/** Tokens the widgets keep as their own (shared/theme.css), not the app's. */
const WIDGET_OWNED = new Set(['--rr-accent']);

/** Keys set by the last call, so a key one theme lacks does not linger. */
let applied: string[] = [];

/** Set the RocketRide token set for `theme` as inline custom properties on <html>. */
export function applyThemeTokens(theme: Theme): void {
	const root = document.documentElement;
	const tokens = TOKENS[theme];
	for (const key of applied) {
		if (!(key in tokens)) root.style.removeProperty(key);
	}
	applied = [];
	for (const [key, value] of Object.entries(tokens)) {
		if (WIDGET_OWNED.has(key)) continue;
		root.style.setProperty(key, value);
		applied.push(key);
	}
}

function applyTheme(theme: Theme): void {
	applyDocumentTheme(theme);
	applyThemeTokens(theme);
}

/**
 * Make `app`'s document follow the host theme, with the OS scheme as the
 * fallback. Call it before `app.connect()`, so no `hostcontextchanged` is
 * missed. Nothing is needed after connecting: the theme in the `ui/initialize`
 * reply has no event of its own, so this wraps the instance's `connect()` and
 * applies it as soon as the handshake ends.
 */
export function applyHostTheme(app: App): void {
	const mq = window.matchMedia('(prefers-color-scheme: dark)');
	const current = (): Theme => app.getHostContext()?.theme ?? (mq.matches ? 'dark' : 'light');

	applyTheme(current());
	mq.addEventListener('change', () => applyTheme(current()));
	// The notification carries only the fields that changed; a change without
	// a theme keeps the host's last one.
	app.addEventListener('hostcontextchanged', (ctx) => applyTheme(ctx.theme ?? current()));

	const connect = app.connect.bind(app);
	app.connect = async (...args: Parameters<App['connect']>) => {
		await connect(...args);
		applyTheme(current());
	};
}
