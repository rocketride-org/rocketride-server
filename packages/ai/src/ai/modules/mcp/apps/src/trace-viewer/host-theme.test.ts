/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * This workspace's vitest environment is `node` (see vitest.config.ts) — no
 * jsdom — so `window`/`document` are stubbed here with just enough surface
 * for host-theme.ts and the real (non-mocked) `applyDocumentTheme` it
 * delegates to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { App } from '@modelcontextprotocol/ext-apps';

import { applyHostTheme } from './host-theme';

type Theme = 'light' | 'dark';
type HostContext = { theme?: Theme } | undefined;

function stubDom(osIsDark: boolean) {
	const attrs: Record<string, string> = {};
	const documentElement = {
		setAttribute: (name: string, value: string) => {
			attrs[name] = value;
		},
		getAttribute: (name: string) => attrs[name],
		style: {} as Record<string, string>,
	};

	let matches = osIsDark;
	const listeners: Array<() => void> = [];
	const mediaQueryList = {
		get matches() {
			return matches;
		},
		addEventListener: (_event: string, cb: () => void) => listeners.push(cb),
		removeEventListener: () => {},
	};

	vi.stubGlobal('document', { documentElement });
	vi.stubGlobal('window', { matchMedia: () => mediaQueryList });

	return {
		attrs,
		fireOsChange(next: boolean) {
			matches = next;
			for (const cb of listeners) cb();
		},
	};
}

/** Minimal fake of the `App` surface applyHostTheme actually touches. */
function fakeApp(initialContext: HostContext) {
	let context = initialContext;
	const hostContextChangedHandlers: Array<(ctx: HostContext) => void> = [];
	const app = {
		getHostContext: () => context,
		addEventListener: (event: string, handler: (ctx: HostContext) => void) => {
			if (event === 'hostcontextchanged') hostContextChangedHandlers.push(handler);
		},
	};
	return {
		app: app as unknown as App,
		fireHostContextChanged(next: HostContext) {
			context = next;
			for (const handler of hostContextChangedHandlers) handler(next);
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('applyHostTheme', () => {
	it('applies the OS scheme immediately when the host has no theme yet', () => {
		const dom = stubDom(true);
		const { app } = fakeApp(undefined);

		applyHostTheme(app);

		expect(dom.attrs['data-theme']).toBe('dark');
	});

	it('applies the host theme instead of the OS scheme when one is already available', () => {
		const dom = stubDom(false); // OS says light
		const { app } = fakeApp({ theme: 'dark' }); // host already knows it's dark

		applyHostTheme(app);

		expect(dom.attrs['data-theme']).toBe('dark');
	});

	it('applies the host theme on hostcontextchanged, overriding the OS fallback', () => {
		const dom = stubDom(true); // OS fallback would be dark
		const { app, fireHostContextChanged } = fakeApp(undefined);

		applyHostTheme(app);
		expect(dom.attrs['data-theme']).toBe('dark'); // fallback applied first

		fireHostContextChanged({ theme: 'light' });
		expect(dom.attrs['data-theme']).toBe('light'); // host wins
	});

	it('still falls back to the OS scheme on later OS changes once the host reports no theme', () => {
		const dom = stubDom(false);
		const { app } = fakeApp(undefined);

		applyHostTheme(app);
		expect(dom.attrs['data-theme']).toBe('light');

		dom.fireOsChange(true);
		expect(dom.attrs['data-theme']).toBe('dark');
	});
});
