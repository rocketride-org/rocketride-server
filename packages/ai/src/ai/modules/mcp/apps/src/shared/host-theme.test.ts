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

import darkTokens from '../../../../../../../../shell/public/themes/dark.json';
import lightTokens from '../../../../../../../../shell/public/themes/light.json';
import { applyHostTheme } from './host-theme';

type Theme = 'light' | 'dark';
type HostContext = { theme?: Theme; displayMode?: string } | undefined;

function stubDom(osIsDark: boolean) {
	const attrs: Record<string, string> = {};
	const props = new Map<string, string>();
	const documentElement = {
		setAttribute: (name: string, value: string) => {
			attrs[name] = value;
		},
		getAttribute: (name: string) => attrs[name],
		style: {
			setProperty: (name: string, value: string) => props.set(name, value),
			removeProperty: (name: string) => props.delete(name),
		} as Record<string, unknown>,
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
		props,
		style: documentElement.style,
		fireOsChange(next: boolean) {
			matches = next;
			for (const cb of listeners) cb();
		},
	};
}

/**
 * Minimal fake of the `App` surface applyHostTheme touches. `connect()` stands
 * in for the handshake: it stores the host context the `ui/initialize` reply
 * carries, which fires no event.
 */
function fakeApp(initialContext: HostContext, contextFromInitialize?: HostContext) {
	let context = initialContext;
	const hostContextChangedHandlers: Array<(ctx: HostContext) => void> = [];
	const app = {
		getHostContext: () => context,
		addEventListener: (event: string, handler: (ctx: HostContext) => void) => {
			if (event === 'hostcontextchanged') hostContextChangedHandlers.push(handler);
		},
		connect: async () => {
			context = contextFromInitialize;
		},
	};
	return {
		app: app as unknown as App,
		/** Like the real App: merge the partial change, then notify. */
		fireHostContextChanged(change: HostContext) {
			context = { ...context, ...change };
			for (const handler of hostContextChangedHandlers) handler(change);
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
		expect(dom.style.colorScheme).toBe('dark');
	});

	it('applies the host theme instead of the OS scheme when one is already available', () => {
		const dom = stubDom(false); // OS says light
		const { app } = fakeApp({ theme: 'dark' }); // host already knows it's dark

		applyHostTheme(app);

		expect(dom.attrs['data-theme']).toBe('dark');
	});

	it('applies the theme from the initialize reply once connect() resolves', async () => {
		const dom = stubDom(false); // OS says light
		const { app } = fakeApp(undefined, { theme: 'dark' });

		applyHostTheme(app);
		expect(dom.attrs['data-theme']).toBe('light'); // fallback before the handshake

		await app.connect();
		expect(dom.attrs['data-theme']).toBe('dark');
		expect(dom.props.get('--rr-bg-default')).toBe(darkTokens['--rr-bg-default']);
	});

	it('applies the host theme on hostcontextchanged, overriding the OS fallback', () => {
		const dom = stubDom(true); // OS fallback would be dark
		const { app, fireHostContextChanged } = fakeApp(undefined);

		applyHostTheme(app);
		expect(dom.attrs['data-theme']).toBe('dark'); // fallback applied first

		fireHostContextChanged({ theme: 'light' });
		expect(dom.attrs['data-theme']).toBe('light'); // host wins
	});

	it('keeps the host theme when a context change carries no theme', () => {
		const dom = stubDom(false); // OS says light
		const { app, fireHostContextChanged } = fakeApp({ theme: 'dark' });

		applyHostTheme(app);
		fireHostContextChanged({ displayMode: 'inline' });

		expect(dom.attrs['data-theme']).toBe('dark');
	});

	it('still falls back to the OS scheme on later OS changes once the host reports no theme', () => {
		const dom = stubDom(false);
		const { app } = fakeApp(undefined);

		applyHostTheme(app);
		expect(dom.attrs['data-theme']).toBe('light');

		dom.fireOsChange(true);
		expect(dom.attrs['data-theme']).toBe('dark');
	});

	it('ignores OS changes while the host has a theme', () => {
		const dom = stubDom(false);
		const { app } = fakeApp({ theme: 'light' });

		applyHostTheme(app);
		dom.fireOsChange(true);

		expect(dom.attrs['data-theme']).toBe('light');
	});
});

describe('RocketRide token set', () => {
	it('changes with the theme', () => {
		const dom = stubDom(false);
		const { app, fireHostContextChanged } = fakeApp({ theme: 'light' });

		applyHostTheme(app);
		expect(dom.props.get('--rr-bg-default')).toBe(lightTokens['--rr-bg-default']);
		expect(dom.props.get('--rr-text-primary')).toBe(lightTokens['--rr-text-primary']);

		fireHostContextChanged({ theme: 'dark' });
		expect(dom.props.get('--rr-bg-default')).toBe(darkTokens['--rr-bg-default']);
		expect(dom.props.get('--rr-text-primary')).toBe(darkTokens['--rr-text-primary']);
		expect(dom.props.get('--rr-bg-default')).not.toBe(lightTokens['--rr-bg-default']);
	});

	it('sets every token of the theme except the widget-owned accent', () => {
		const dom = stubDom(false);
		const { app } = fakeApp({ theme: 'dark' });

		applyHostTheme(app);

		const expected = Object.keys(darkTokens).filter((key) => key !== '--rr-accent');
		expect([...dom.props.keys()].sort()).toEqual(expected.sort());
		expect(dom.props.has('--rr-accent')).toBe(false);
	});

	it('raises the faint text tokens to AA contrast for the widgets', () => {
		const dom = stubDom(false);
		const { app, fireHostContextChanged } = fakeApp({ theme: 'dark' });

		applyHostTheme(app);
		expect(dom.props.get('--rr-text-disabled')).toBe('#a0a0a0');
		expect(dom.props.get('--rr-brand')).toBe('#41b6e6');

		fireHostContextChanged({ theme: 'light' });
		expect(dom.props.get('--rr-text-disabled')).toBe('#6b6b6b');
		expect(dom.props.get('--rr-brand')).toBe('#0b6f9c');
	});

	it('drops a token the next theme does not define', () => {
		const lightOnly = Object.keys(lightTokens).filter((key) => !(key in darkTokens));
		expect(lightOnly.length).toBeGreaterThan(0); // the case this test exists for

		const dom = stubDom(false);
		const { app, fireHostContextChanged } = fakeApp({ theme: 'light' });

		applyHostTheme(app);
		for (const key of lightOnly) expect(dom.props.has(key)).toBe(true);

		fireHostContextChanged({ theme: 'dark' });
		for (const key of lightOnly) expect(dom.props.has(key)).toBe(false);
	});
});
