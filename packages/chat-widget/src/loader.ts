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
 * RocketRide Chat Widget — script-tag loader.
 *
 * Turns a single `<script>` tag into a floating chat "bubble": a launcher
 * button fixed to a corner of the page which opens a panel hosting the
 * `<rocketride-chat>` web component. Configuration is read from the script
 * tag's `data-*` attributes via `document.currentScript`:
 *
 * ```html
 * <script src="https://cdn.example.com/rocketride-chat.js"
 *         data-engine-url="http://localhost:5565"
 *         data-auth="YOUR-PUBLIC-AUTH-KEY"
 *         data-title="RocketRide Assistant"
 *         data-accent="#5f2167"
 *         data-position="bottom-right"
 *         data-welcome="Hi! How can I help?"
 *         data-placeholder="Ask me anything..."
 *         data-theme="auto"
 *         defer></script>
 * ```
 *
 * SECURITY — public auth key ONLY:
 * `data-auth` must be the pipeline's PUBLIC authorization key — the same
 * value the chat source node publishes in its `{host}/chat?auth={public_auth}`
 * link. It is scoped to a single running pipeline's chat endpoint. NEVER put
 * the RocketRide engine API key or any private token into a web page: every
 * visitor can read it.
 *
 * The launcher and panel are rendered inside a shadow root so host-page CSS
 * cannot restyle them (and widget CSS cannot leak out). Theming is exposed
 * through CSS custom properties (`--rr-accent`, `--rr-font`, `--rr-radius`)
 * set on the bubble host element, which inherit into the shadow tree and the
 * embedded `<rocketride-chat>` component.
 *
 * @module loader
 */

import { DEFAULT_ACCENT } from './styles';

/** Tag name of the chat web component this loader mounts. */
export const CHAT_TAG = 'rocketride-chat';

/** Default brand accent (RocketRide violet), shared with styles.ts. */
export { DEFAULT_ACCENT };

/** Default panel/dialog title. */
export const DEFAULT_TITLE = 'RocketRide Assistant';

/** Corner of the viewport the launcher bubble is pinned to. */
export type BubblePosition = 'bottom-right' | 'bottom-left';

/** Color scheme for the widget. `auto` follows `prefers-color-scheme`. */
export type BubbleTheme = 'light' | 'dark' | 'auto';

const VALID_POSITIONS: readonly BubblePosition[] = ['bottom-right', 'bottom-left'];
const VALID_THEMES: readonly BubbleTheme[] = ['light', 'dark', 'auto'];
const DEFAULT_POSITION: BubblePosition = 'bottom-right';
const DEFAULT_THEME: BubbleTheme = 'auto';

/** Marker set on a script tag once the loader has mounted from it. */
const MOUNTED_FLAG = 'rocketrideChatMounted';

/**
 * Configuration parsed from a loader `<script>` tag's `data-*` attributes.
 */
export interface LoaderConfig {
	/** Base URL of the RocketRide engine, e.g. `http://localhost:5565` (from `data-engine-url`, required). */
	engineUrl: string;
	/**
	 * PUBLIC authorization key of the pipeline's chat endpoint (from `data-auth`).
	 * This is the `{public_auth}` value from the chat node's published
	 * `{host}/chat?auth={public_auth}` link — never an engine API key.
	 */
	auth?: string;
	/** Panel title / accessible dialog name (from `data-title`). */
	title: string;
	/** Brand accent color, any CSS color value (from `data-accent`). */
	accent: string;
	/** Viewport corner for the launcher (from `data-position`). */
	position: BubblePosition;
	/** Optional welcome message shown by the chat component (from `data-welcome`). */
	welcome?: string;
	/** Optional input placeholder for the chat component (from `data-placeholder`). */
	placeholder?: string;
	/** Color scheme (from `data-theme`). */
	theme: BubbleTheme;
}

/**
 * Handle returned by {@link mountChatBubble} for programmatic control and
 * for tests. All elements live inside the bubble host's shadow root.
 */
export interface ChatBubbleHandle {
	/** Light-DOM host element appended to `document.body`. */
	host: HTMLElement;
	/** The launcher `<button>` (carries `aria-expanded`). */
	launcher: HTMLButtonElement;
	/** The panel wrapper (`role="dialog"`) that hosts the chat component. */
	panel: HTMLElement;
	/** The embedded `<rocketride-chat>` element. */
	chat: HTMLElement;
	/** Opens the panel and moves focus into it. */
	open(): void;
	/** Closes the panel and returns focus to the launcher. */
	close(): void;
	/** Toggles the panel. */
	toggle(): void;
	/** Whether the panel is currently open. */
	isOpen(): boolean;
	/** Removes the bubble from the page and detaches listeners. */
	destroy(): void;
}

/**
 * Parses a loader configuration from a script element's `data-*` attributes.
 *
 * Rules:
 * - `data-engine-url` is required; without it this returns `null` (the
 *   bundle then only defines the web component and mounts nothing).
 * - Values are trimmed; empty strings count as absent.
 * - Invalid `data-position` / `data-theme` values fall back to their
 *   defaults (`bottom-right` / `auto`) with a console warning.
 *
 * @param script - The `<script>` element to read, usually `document.currentScript`.
 * @returns The parsed configuration, or `null` when `data-engine-url` is missing.
 */
export function parseLoaderConfig(script: HTMLScriptElement | null | undefined): LoaderConfig | null {
	if (!script || !script.dataset) {
		return null;
	}
	const data = script.dataset;

	const engineUrl = (data.engineUrl ?? '').trim();
	if (!engineUrl) {
		return null;
	}

	let position: BubblePosition = DEFAULT_POSITION;
	const rawPosition = (data.position ?? '').trim();
	if (rawPosition) {
		if ((VALID_POSITIONS as readonly string[]).includes(rawPosition)) {
			position = rawPosition as BubblePosition;
		} else {
			console.warn(
				`[rocketride-chat] Invalid data-position "${rawPosition}" — expected one of ${VALID_POSITIONS.join(', ')}. ` +
				`Falling back to "${DEFAULT_POSITION}".`
			);
		}
	}

	let theme: BubbleTheme = DEFAULT_THEME;
	const rawTheme = (data.theme ?? '').trim();
	if (rawTheme) {
		if ((VALID_THEMES as readonly string[]).includes(rawTheme)) {
			theme = rawTheme as BubbleTheme;
		} else {
			console.warn(
				`[rocketride-chat] Invalid data-theme "${rawTheme}" — expected one of ${VALID_THEMES.join(', ')}. ` +
				`Falling back to "${DEFAULT_THEME}".`
			);
		}
	}

	const auth = (data.auth ?? '').trim();
	const welcome = (data.welcome ?? '').trim();
	const placeholder = (data.placeholder ?? '').trim();

	return {
		engineUrl,
		...(auth ? { auth } : {}),
		title: (data.title ?? '').trim() || DEFAULT_TITLE,
		accent: (data.accent ?? '').trim() || DEFAULT_ACCENT,
		position,
		...(welcome ? { welcome } : {}),
		...(placeholder ? { placeholder } : {}),
		theme,
	};
}

/** Accessible labels for the launcher's two states. */
const LABEL_OPEN = 'Open chat';
const LABEL_CLOSE = 'Close chat';

/**
 * Static, trusted SVG markup for the launcher icons (chat bubble / close X).
 * Never derived from user or model input.
 */
const ICON_CHAT_SVG =
	'<svg class="rr-icon rr-icon-chat" viewBox="0 0 24 24" width="26" height="26" fill="none" ' +
	'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
	'<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
	'</svg>';

const ICON_CLOSE_SVG =
	'<svg class="rr-icon rr-icon-close" viewBox="0 0 24 24" width="26" height="26" fill="none" ' +
	'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
	'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
	'</svg>';

/**
 * Styles for the bubble chrome. Scoped inside the bubble's shadow root, so
 * they cannot collide with host-page CSS in either direction.
 */
const BUBBLE_CSS = `
:host {
	all: initial;
}
*, *::before, *::after {
	box-sizing: border-box;
}
.rr-bubble {
	position: fixed;
	bottom: 20px;
	z-index: 2147483000;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 12px;
	font-family: var(--rr-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
}
.rr-pos-bottom-right {
	right: 20px;
}
.rr-pos-bottom-left {
	left: 20px;
	align-items: flex-start;
}
.rr-launcher {
	width: 56px;
	height: 56px;
	padding: 0;
	border: none;
	border-radius: 50%;
	background: var(--rr-accent, ${DEFAULT_ACCENT});
	color: #ffffff;
	cursor: pointer;
	display: grid;
	place-items: center;
	box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
	transition: transform 0.15s ease, filter 0.15s ease;
}
.rr-launcher:hover {
	filter: brightness(1.1);
}
.rr-launcher:active {
	transform: scale(0.94);
}
.rr-launcher:focus-visible {
	outline: 2px solid var(--rr-accent, ${DEFAULT_ACCENT});
	outline-offset: 3px;
}
.rr-launcher .rr-icon-close {
	display: none;
}
.rr-open .rr-launcher .rr-icon-chat {
	display: none;
}
.rr-open .rr-launcher .rr-icon-close {
	display: block;
}
.rr-panel {
	width: min(380px, calc(100vw - 40px));
	height: min(600px, calc(100vh - 110px));
	height: min(600px, calc(100dvh - 110px));
	border-radius: var(--rr-radius, 16px);
	overflow: hidden;
	box-shadow: 0 12px 48px rgba(0, 0, 0, 0.28);
	background: transparent;
}
.rr-panel[hidden] {
	display: none;
}
${CHAT_TAG} {
	display: block;
	width: 100%;
	height: 100%;
}
@media (prefers-reduced-motion: reduce) {
	.rr-launcher {
		transition: none;
	}
}
`;

/**
 * Mounts the launcher bubble + chat panel for the given configuration.
 *
 * The bubble is a light-DOM `<div>` host with an open shadow root containing
 * the launcher `<button>` and a `role="dialog"` panel that hosts the
 * `<rocketride-chat>` element. Accessibility behavior:
 * - launcher carries `aria-expanded` + `aria-haspopup="dialog"`,
 * - opening moves focus into the panel,
 * - Escape closes the panel and returns focus to the launcher.
 *
 * The element is appended to `document.body` immediately, or on
 * `DOMContentLoaded` when the body does not exist yet (script in `<head>`
 * without `defer`).
 *
 * @param config - Parsed loader configuration (see {@link parseLoaderConfig}).
 * @param doc - Document to mount into (injectable for tests).
 * @returns A handle for programmatic open/close/destroy.
 */
export function mountChatBubble(config: LoaderConfig, doc: Document = document): ChatBubbleHandle {
	const host = doc.createElement('div');
	host.setAttribute('data-rocketride-chat-bubble', '');
	// Custom properties on the host inherit into the shadow tree and into the
	// <rocketride-chat> component, so a single assignment themes everything.
	host.style.setProperty('--rr-accent', config.accent);

	const shadow = host.attachShadow({ mode: 'open' });

	const style = doc.createElement('style');
	style.textContent = BUBBLE_CSS;

	const wrapper = doc.createElement('div');
	wrapper.className = `rr-bubble rr-pos-${config.position}`;

	const panel = doc.createElement('div');
	panel.className = 'rr-panel';
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-label', config.title);
	panel.tabIndex = -1;
	panel.hidden = true;

	const chat = doc.createElement(CHAT_TAG);
	chat.setAttribute('engine-url', config.engineUrl);
	if (config.auth) {
		chat.setAttribute('auth', config.auth);
	}
	chat.setAttribute('title', config.title);
	chat.setAttribute('accent', config.accent);
	chat.setAttribute('theme', config.theme);
	if (config.welcome) {
		chat.setAttribute('welcome', config.welcome);
	}
	if (config.placeholder) {
		chat.setAttribute('placeholder', config.placeholder);
	}
	panel.appendChild(chat);

	const launcher = doc.createElement('button');
	launcher.type = 'button';
	launcher.className = 'rr-launcher';
	launcher.setAttribute('aria-expanded', 'false');
	launcher.setAttribute('aria-haspopup', 'dialog');
	launcher.setAttribute('aria-label', LABEL_OPEN);
	// Static trusted markup only — never user/model input.
	launcher.innerHTML = ICON_CHAT_SVG + ICON_CLOSE_SVG;

	wrapper.appendChild(panel);
	wrapper.appendChild(launcher);
	shadow.appendChild(style);
	shadow.appendChild(wrapper);

	let openState = false;

	const open = (): void => {
		if (openState) {
			return;
		}
		openState = true;
		panel.hidden = false;
		wrapper.classList.add('rr-open');
		launcher.setAttribute('aria-expanded', 'true');
		launcher.setAttribute('aria-label', LABEL_CLOSE);
		// Move keyboard focus into the widget. The chat component may delegate
		// focus to its input; if focus did not land inside the bubble, fall
		// back to the (tabindex="-1") panel itself.
		chat.focus();
		if (doc.activeElement !== host) {
			panel.focus();
		}
	};

	const close = (): void => {
		if (!openState) {
			return;
		}
		openState = false;
		panel.hidden = true;
		wrapper.classList.remove('rr-open');
		launcher.setAttribute('aria-expanded', 'false');
		launcher.setAttribute('aria-label', LABEL_OPEN);
		launcher.focus();
	};

	const toggle = (): void => {
		if (openState) {
			close();
		} else {
			open();
		}
	};

	const onLauncherClick = (): void => toggle();

	// Keyboard events from inside the shadow tree are composed, so they
	// retarget to the host — one listener covers launcher, panel and chat.
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape' && openState) {
			event.stopPropagation();
			close();
		}
	};

	launcher.addEventListener('click', onLauncherClick);
	host.addEventListener('keydown', onKeyDown);

	const attach = (): void => {
		(doc.body ?? doc.documentElement).appendChild(host);
	};
	if (doc.body) {
		attach();
	} else {
		doc.addEventListener('DOMContentLoaded', attach, { once: true });
	}

	const destroy = (): void => {
		launcher.removeEventListener('click', onLauncherClick);
		host.removeEventListener('keydown', onKeyDown);
		doc.removeEventListener('DOMContentLoaded', attach);
		host.remove();
	};

	return {
		host,
		launcher,
		panel,
		chat,
		open,
		close,
		toggle,
		isOpen: () => openState,
		destroy,
	};
}

/**
 * Auto-initializes the bubble from a loader `<script>` tag.
 *
 * Reads `document.currentScript` (available during synchronous evaluation of
 * classic scripts, including `defer`red ones) and mounts the bubble when the
 * tag carries a `data-engine-url`. Idempotent per script tag: a second call
 * for the same tag is a no-op.
 *
 * @param script - Script element to initialize from; defaults to `document.currentScript`.
 * @returns The bubble handle, or `null` when there is nothing to mount.
 */
export function initFromScript(
	script: HTMLScriptElement | null = (typeof document !== 'undefined'
		? (document.currentScript as HTMLScriptElement | null)
		: null)
): ChatBubbleHandle | null {
	const config = parseLoaderConfig(script);
	if (!config || !script) {
		return null;
	}
	if (script.dataset[MOUNTED_FLAG] === 'true') {
		return null;
	}
	// Page-level guard: two separate <script> includes load two independent
	// module scopes, so the per-script flag alone cannot deduplicate them.
	const doc = script.ownerDocument ?? document;
	if (doc.querySelector('[data-rocketride-chat-bubble]')) {
		return null;
	}
	script.dataset[MOUNTED_FLAG] = 'true';
	return mountChatBubble(config, doc);
}
