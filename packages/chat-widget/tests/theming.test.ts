/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Theming tests: accent -> CSS custom property, launcher/bubble position,
 * and the component's light/dark/auto (prefers-color-scheme) resolution.
 */

import { RocketRideChatElement, WIDGET_TAG } from '../src/component';
import '../src/index'; // registers the custom element (guarded)
import { ChatBubbleHandle, DEFAULT_ACCENT, mountChatBubble, LoaderConfig } from '../src/loader';
import { flush } from './helpers';

const BASE_CONFIG: LoaderConfig = {
	engineUrl: 'http://localhost:5565',
	title: 'Theming',
	accent: DEFAULT_ACCENT,
	position: 'bottom-right',
	theme: 'auto',
};

/** Stubs window.matchMedia with a fixed prefers-color-scheme answer. */
function stubMatchMedia(prefersDark: boolean): jest.Mock {
	const mock = jest.fn().mockImplementation((query: string) => ({
		matches: prefersDark && query.includes('prefers-color-scheme: dark'),
		media: query,
		addEventListener: jest.fn(),
		removeEventListener: jest.fn(),
	}));
	Object.defineProperty(window, 'matchMedia', { value: mock, writable: true, configurable: true });
	return mock;
}

function clearMatchMedia(): void {
	delete (window as Record<string, any>).matchMedia;
}

describe('loader bubble theming', () => {
	const handles: ChatBubbleHandle[] = [];

	function mount(overrides: Partial<LoaderConfig> = {}): ChatBubbleHandle {
		const handle = mountChatBubble({ ...BASE_CONFIG, ...overrides });
		handles.push(handle);
		return handle;
	}

	afterEach(() => {
		while (handles.length > 0) {
			handles.pop()?.destroy();
		}
		document.body.innerHTML = '';
	});

	it('sets --rr-accent on the bubble host (default RocketRide violet)', () => {
		const { host } = mount();
		expect(host.style.getPropertyValue('--rr-accent')).toBe('#5f2167');
	});

	it('propagates a custom accent to the host property and the chat element', () => {
		const { host, chat } = mount({ accent: '#0a84ff' });
		expect(host.style.getPropertyValue('--rr-accent')).toBe('#0a84ff');
		expect(chat.getAttribute('accent')).toBe('#0a84ff');
	});

	it('styles the launcher through the accent custom property', () => {
		const { host } = mount();
		const css = host.shadowRoot?.querySelector('style')?.textContent ?? '';
		expect(css).toContain('var(--rr-accent');
	});

	it('positions bottom-right by default and bottom-left on request', () => {
		const right = mount();
		const rightWrapper = right.host.shadowRoot?.querySelector('.rr-bubble');
		expect(rightWrapper?.classList.contains('rr-pos-bottom-right')).toBe(true);

		const left = mount({ position: 'bottom-left' });
		const leftWrapper = left.host.shadowRoot?.querySelector('.rr-bubble');
		expect(leftWrapper?.classList.contains('rr-pos-bottom-left')).toBe(true);
		expect(leftWrapper?.classList.contains('rr-pos-bottom-right')).toBe(false);
	});

	it('forwards the theme setting to the chat element', () => {
		for (const theme of ['light', 'dark', 'auto'] as const) {
			const { chat } = mount({ theme });
			expect(chat.getAttribute('theme')).toBe(theme);
		}
	});
});

describe('component theming', () => {
	async function createChat(attrs: Record<string, string> = {}): Promise<RocketRideChatElement> {
		const el = document.createElement(WIDGET_TAG) as RocketRideChatElement;
		// No engine-url/auth: theming works without any connection.
		for (const [name, value] of Object.entries(attrs)) {
			el.setAttribute(name, value);
		}
		document.body.appendChild(el);
		await flush(1);
		return el;
	}

	function getRoot(el: RocketRideChatElement): HTMLElement {
		return el.shadowRoot?.querySelector('.rr-root') as HTMLElement;
	}

	afterEach(() => {
		document.body.innerHTML = '';
		clearMatchMedia();
	});

	it('maps the accent attribute to the --rr-accent custom property', async () => {
		const el = await createChat({ accent: '#ff8800' });
		expect(getRoot(el).style.getPropertyValue('--rr-accent')).toBe('#ff8800');
	});

	it('falls back to the stylesheet default accent when the attribute is absent', async () => {
		const el = await createChat();
		expect(getRoot(el).style.getPropertyValue('--rr-accent')).toBe('');
		const css = el.shadowRoot?.querySelector('style')?.textContent ?? '';
		expect(css).toContain('#5f2167');
	});

	it('updates the accent live on attribute change', async () => {
		const el = await createChat({ accent: '#ff8800' });
		el.setAttribute('accent', '#123123');
		expect(getRoot(el).style.getPropertyValue('--rr-accent')).toBe('#123123');
	});

	it('applies explicit light and dark themes', async () => {
		const light = await createChat({ theme: 'light' });
		expect(getRoot(light).getAttribute('data-theme')).toBe('light');

		const dark = await createChat({ theme: 'dark' });
		expect(getRoot(dark).getAttribute('data-theme')).toBe('dark');
	});

	it('resolves auto theme from prefers-color-scheme', async () => {
		stubMatchMedia(true);
		const dark = await createChat({ theme: 'auto' });
		expect(getRoot(dark).getAttribute('data-theme')).toBe('dark');
		document.body.innerHTML = '';

		stubMatchMedia(false);
		const light = await createChat({ theme: 'auto' });
		expect(getRoot(light).getAttribute('data-theme')).toBe('light');
	});

	it('defaults to auto when the theme attribute is missing or invalid', async () => {
		stubMatchMedia(true);
		const missing = await createChat();
		expect(getRoot(missing).getAttribute('data-theme')).toBe('dark');
		document.body.innerHTML = '';

		const invalid = await createChat({ theme: 'sepia' });
		expect(getRoot(invalid).getAttribute('data-theme')).toBe('dark');
	});

	it('switches theme live on attribute change', async () => {
		const el = await createChat({ theme: 'light' });
		el.setAttribute('theme', 'dark');
		expect(getRoot(el).getAttribute('data-theme')).toBe('dark');
	});

	it('ships light and dark palettes in the shadow stylesheet', async () => {
		const el = await createChat();
		const css = el.shadowRoot?.querySelector('style')?.textContent ?? '';
		expect(css).toContain('data-theme');
		expect(css).toContain('--rr-accent');
	});
});
