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
 * Tests for the script-tag loader (src/loader.ts): data-* config parsing,
 * launcher bubble DOM/accessibility, open/close/Escape behavior, and
 * idempotent auto-initialization.
 */

import {
	CHAT_TAG,
	ChatBubbleHandle,
	DEFAULT_ACCENT,
	DEFAULT_TITLE,
	LoaderConfig,
	initFromScript,
	mountChatBubble,
	parseLoaderConfig,
} from '../src/loader';
import { pressKey } from './helpers';

/** Creates a detached <script> carrying the given data-* attributes. */
function makeScript(data: Record<string, string> = {}): HTMLScriptElement {
	const script = document.createElement('script');
	for (const [key, value] of Object.entries(data)) {
		script.setAttribute(`data-${key}`, value);
	}
	return script;
}

const BASE_CONFIG: LoaderConfig = {
	engineUrl: 'http://localhost:5565',
	auth: 'TEST-PUBLIC-AUTH-KEY',
	title: 'Test Chat',
	accent: '#123456',
	position: 'bottom-right',
	welcome: 'Hello!',
	placeholder: 'Type here...',
	theme: 'auto',
};

describe('parseLoaderConfig', () => {
	let warnSpy: jest.SpyInstance;

	beforeEach(() => {
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('returns null without a script element', () => {
		expect(parseLoaderConfig(null)).toBeNull();
		expect(parseLoaderConfig(undefined)).toBeNull();
	});

	it('returns null when data-engine-url is missing or blank', () => {
		expect(parseLoaderConfig(makeScript())).toBeNull();
		expect(parseLoaderConfig(makeScript({ auth: 'TEST-PUBLIC-AUTH-KEY' }))).toBeNull();
		expect(parseLoaderConfig(makeScript({ 'engine-url': '' }))).toBeNull();
		expect(parseLoaderConfig(makeScript({ 'engine-url': '   ' }))).toBeNull();
	});

	it('applies documented defaults when only data-engine-url is present', () => {
		const config = parseLoaderConfig(makeScript({ 'engine-url': 'http://localhost:5565' }));
		expect(config).toEqual({
			engineUrl: 'http://localhost:5565',
			title: DEFAULT_TITLE,
			accent: DEFAULT_ACCENT,
			position: 'bottom-right',
			theme: 'auto',
		});
	});

	it('parses every documented data-* attribute', () => {
		const config = parseLoaderConfig(makeScript({
			'engine-url': 'http://engine.test:5565',
			auth: 'TEST-PUBLIC-AUTH-KEY',
			title: 'Support',
			accent: '#ff8800',
			position: 'bottom-left',
			welcome: 'Hi there',
			placeholder: 'Ask away',
			theme: 'dark',
		}));
		expect(config).toEqual({
			engineUrl: 'http://engine.test:5565',
			auth: 'TEST-PUBLIC-AUTH-KEY',
			title: 'Support',
			accent: '#ff8800',
			position: 'bottom-left',
			welcome: 'Hi there',
			placeholder: 'Ask away',
			theme: 'dark',
		});
	});

	it('trims attribute values', () => {
		const config = parseLoaderConfig(makeScript({
			'engine-url': '  http://localhost:5565  ',
			auth: '  TEST-PUBLIC-AUTH-KEY  ',
			title: '  Padded  ',
		}));
		expect(config?.engineUrl).toBe('http://localhost:5565');
		expect(config?.auth).toBe('TEST-PUBLIC-AUTH-KEY');
		expect(config?.title).toBe('Padded');
	});

	it('falls back to bottom-right for invalid data-position, with a warning', () => {
		const config = parseLoaderConfig(makeScript({
			'engine-url': 'http://localhost:5565',
			position: 'top-center',
		}));
		expect(config?.position).toBe('bottom-right');
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('top-center'));
	});

	it('accepts bottom-left without warning', () => {
		const config = parseLoaderConfig(makeScript({
			'engine-url': 'http://localhost:5565',
			position: 'bottom-left',
		}));
		expect(config?.position).toBe('bottom-left');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('falls back to auto for invalid data-theme, with a warning', () => {
		const config = parseLoaderConfig(makeScript({
			'engine-url': 'http://localhost:5565',
			theme: 'sepia',
		}));
		expect(config?.theme).toBe('auto');
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sepia'));
	});

	it('accepts light and dark themes', () => {
		for (const theme of ['light', 'dark'] as const) {
			const config = parseLoaderConfig(makeScript({ 'engine-url': 'http://x.test', theme }));
			expect(config?.theme).toBe(theme);
		}
	});
});

describe('mountChatBubble', () => {
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

	it('appends a shadow host to document.body', () => {
		const { host } = mount();
		expect(host.isConnected).toBe(true);
		expect(host.parentElement).toBe(document.body);
		expect(host.shadowRoot).not.toBeNull();
		expect(host.hasAttribute('data-rocketride-chat-bubble')).toBe(true);
	});

	it('renders an accessible launcher button', () => {
		const { launcher } = mount();
		expect(launcher.tagName).toBe('BUTTON');
		expect(launcher.type).toBe('button');
		expect(launcher.getAttribute('aria-expanded')).toBe('false');
		expect(launcher.getAttribute('aria-haspopup')).toBe('dialog');
		expect(launcher.getAttribute('aria-label')).toBe('Open chat');
	});

	it('renders a hidden dialog panel titled from the config', () => {
		const { panel } = mount();
		expect(panel.getAttribute('role')).toBe('dialog');
		expect(panel.getAttribute('aria-label')).toBe('Test Chat');
		expect(panel.hidden).toBe(true);
		expect(panel.tabIndex).toBe(-1);
	});

	it('hosts a <rocketride-chat> with all config passed through as attributes', () => {
		const { chat, panel } = mount();
		expect(chat.tagName.toLowerCase()).toBe(CHAT_TAG);
		expect(chat.parentElement).toBe(panel);
		expect(chat.getAttribute('engine-url')).toBe('http://localhost:5565');
		expect(chat.getAttribute('auth')).toBe('TEST-PUBLIC-AUTH-KEY');
		expect(chat.getAttribute('title')).toBe('Test Chat');
		expect(chat.getAttribute('accent')).toBe('#123456');
		expect(chat.getAttribute('theme')).toBe('auto');
		expect(chat.getAttribute('welcome')).toBe('Hello!');
		expect(chat.getAttribute('placeholder')).toBe('Type here...');
	});

	it('omits optional attributes that were not configured', () => {
		const { chat } = mount({ auth: undefined, welcome: undefined, placeholder: undefined });
		expect(chat.hasAttribute('auth')).toBe(false);
		expect(chat.hasAttribute('welcome')).toBe(false);
		expect(chat.hasAttribute('placeholder')).toBe(false);
	});

	it('opens on launcher click: aria-expanded, visible panel, focus moves in', () => {
		const handle = mount();
		const panelFocus = jest.spyOn(handle.panel, 'focus');

		handle.launcher.click();

		expect(handle.isOpen()).toBe(true);
		expect(handle.panel.hidden).toBe(false);
		expect(handle.launcher.getAttribute('aria-expanded')).toBe('true');
		expect(handle.launcher.getAttribute('aria-label')).toBe('Close chat');
		expect(panelFocus).toHaveBeenCalled();
	});

	it('closes on second launcher click and returns focus to the launcher', () => {
		const handle = mount();
		const launcherFocus = jest.spyOn(handle.launcher, 'focus');

		handle.launcher.click();
		handle.launcher.click();

		expect(handle.isOpen()).toBe(false);
		expect(handle.panel.hidden).toBe(true);
		expect(handle.launcher.getAttribute('aria-expanded')).toBe('false');
		expect(handle.launcher.getAttribute('aria-label')).toBe('Open chat');
		expect(launcherFocus).toHaveBeenCalled();
	});

	it('closes on Escape and refocuses the launcher', () => {
		const handle = mount();
		const launcherFocus = jest.spyOn(handle.launcher, 'focus');

		handle.open();
		pressKey(handle.host, 'Escape');

		expect(handle.isOpen()).toBe(false);
		expect(handle.panel.hidden).toBe(true);
		expect(launcherFocus).toHaveBeenCalled();
	});

	it('handles Escape composed from inside the shadow tree (e.g. focus on the launcher)', () => {
		const handle = mount();
		handle.open();

		pressKey(handle.launcher, 'Escape');

		expect(handle.isOpen()).toBe(false);
	});

	it('ignores Escape while closed and other keys while open', () => {
		const handle = mount();

		pressKey(handle.host, 'Escape');
		expect(handle.isOpen()).toBe(false);

		handle.open();
		pressKey(handle.host, 'Enter');
		pressKey(handle.host, 'a');
		expect(handle.isOpen()).toBe(true);
	});

	it('exposes a programmatic open/close/toggle API', () => {
		const handle = mount();

		expect(handle.isOpen()).toBe(false);
		handle.open();
		expect(handle.isOpen()).toBe(true);
		handle.open(); // idempotent
		expect(handle.isOpen()).toBe(true);
		handle.close();
		expect(handle.isOpen()).toBe(false);
		handle.close(); // idempotent
		expect(handle.isOpen()).toBe(false);
		handle.toggle();
		expect(handle.isOpen()).toBe(true);
		handle.toggle();
		expect(handle.isOpen()).toBe(false);
	});

	it('destroy() removes the bubble and detaches listeners', () => {
		const handle = mount();
		handle.destroy();

		expect(document.querySelector('[data-rocketride-chat-bubble]')).toBeNull();
		// Click after destroy must be inert (listener removed).
		handle.launcher.click();
		expect(handle.isOpen()).toBe(false);
	});
});

describe('initFromScript', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('mounts the bubble for a script tag with data-engine-url', () => {
		const script = makeScript({
			'engine-url': 'http://engine.test:5565',
			auth: 'TEST-PUBLIC-AUTH-KEY',
			title: 'From Script',
		});
		document.body.appendChild(script);

		const handle = initFromScript(script);

		expect(handle).not.toBeNull();
		expect(document.querySelector('[data-rocketride-chat-bubble]')).toBe(handle?.host);
		expect(handle?.chat.getAttribute('engine-url')).toBe('http://engine.test:5565');
		handle?.destroy();
	});

	it('is idempotent per script tag', () => {
		const script = makeScript({ 'engine-url': 'http://engine.test:5565' });
		document.body.appendChild(script);

		const first = initFromScript(script);
		const second = initFromScript(script);

		expect(first).not.toBeNull();
		expect(second).toBeNull();
		expect(document.querySelectorAll('[data-rocketride-chat-bubble]')).toHaveLength(1);
		first?.destroy();
	});

	it('mounts only one bubble when two separate script tags are included', () => {
		// Two independent <script> includes load two module scopes, so the
		// per-script flag alone cannot deduplicate — the page-level guard must.
		const first = makeScript({ 'engine-url': 'http://engine.test:5565' });
		const second = makeScript({ 'engine-url': 'http://engine.test:5565' });
		document.body.appendChild(first);
		document.body.appendChild(second);

		const firstHandle = initFromScript(first);
		const secondHandle = initFromScript(second);

		expect(firstHandle).not.toBeNull();
		expect(secondHandle).toBeNull();
		expect(document.querySelectorAll('[data-rocketride-chat-bubble]')).toHaveLength(1);
		firstHandle?.destroy();
	});

	it('returns null for a script tag without data-engine-url', () => {
		const script = makeScript({ title: 'No engine' });
		document.body.appendChild(script);

		expect(initFromScript(script)).toBeNull();
		expect(document.querySelector('[data-rocketride-chat-bubble]')).toBeNull();
	});

	it('returns null when there is no current script', () => {
		expect(initFromScript(null)).toBeNull();
	});
});
