// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// useShellEvents — standard shell ↔ iframe bridge hook
// =============================================================================
//
// Call once in any iframe provider. Handles all cross-cutting shell messages:
//   - ready  → shell:init
//   - shell:themeChange / shell:connected / shell:disconnected /
//     shell:login / shell:logout / shell:event → forwarded to iframe
//   - shell:logout from iframe → triggers shell logout
//   - shell:openTab from iframe → dispatches shell:openSingleton window event
// =============================================================================

import { RefObject, useEffect, useRef, useCallback } from 'react';
import { useAuthUser, useLogout } from '../hooks/useAuthUser';
import { useShellConnection } from '../connection/ConnectionContext';
import { useShellApiConfig } from '../connection/ShellApiConfigContext';
import { ConnectionManager } from '../connection/connection';
import type { ShellToIframeMsg } from './ShellIframeProtocol';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Reads all `--rr-*` CSS custom properties currently set as inline styles on
 * `document.documentElement` (i.e. the `:root` element).
 *
 * The shell writes theme tokens directly to `document.documentElement.style` so
 * they are available as inline style properties rather than computed stylesheet
 * values.  Only inline styles are read here because `getComputedStyle` includes
 * inherited values and cannot reliably distinguish shell tokens from other CSS.
 *
 * @returns A key/value map of every `--rr-*` token and its trimmed string value.
 */
function readCssTokens(): Record<string, string> {
	// Access only the element's inline style declaration, not the full computed style
	const inlineStyle = document.documentElement.style;
	const tokens: Record<string, string> = {};
	// Iterate every inline property by index to find all --rr-* tokens
	for (let i = 0; i < inlineStyle.length; i++) {
		const prop = inlineStyle[i];
		// Only include RocketRide design token properties; ignore all other CSS vars
		if (prop.startsWith('--rr-')) {
			tokens[prop] = inlineStyle.getPropertyValue(prop).trim();
		}
	}
	return tokens;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Sets up the full shell ↔ iframe postMessage bridge for a single iframe element.
 *
 * This hook must be called once per iframe component.  It installs three things:
 *
 * 1. An inbound `MessageEvent` listener on `window` that handles messages
 *    originating from the iframe (`view:ready`, `shell:logout`, `shell:openTab`).
 *
 * 2. Subscriptions to the `connectionManager` singleton that forward shell-wide events
 *    (`shell:themeChange`, `shell:connected`, `shell:disconnected`, `shell:login`,
 *    `shell:logout`, `shell:event`, `shell:viewActivated`) to the iframe as typed
 *    `postMessage` calls — but only after the iframe has signalled `view:ready`.
 *
 * 3. A stable `sendInit` callback that assembles and posts the `shell:init`
 *    bootstrap message (theme tokens, auth user, connection state, API config).
 *
 * All subscriptions are cleaned up when the component unmounts.
 *
 * @param iframeRef - A ref pointing to the `<iframe>` DOM element to bridge.
 */
export function useShellEvents(iframeRef: RefObject<HTMLIFrameElement>): void {
	// Retrieve current auth user from the shell's auth provider
	const authUser = useAuthUser();
	// Retrieve the current WebSocket connection status
	const { isConnected } = useShellConnection();
	// Retrieve the full RR_* API config object
	const apiConfig = useShellApiConfig();
	// Retrieve the logout callback (Zitadel PKCE end-session flow)
	const logout = useLogout();

	// Keep latest values accessible inside callbacks without re-registering
	// Using refs avoids stale closure issues in long-lived event listeners
	const authUserRef = useRef(authUser);
	authUserRef.current = authUser;
	const isConnectedRef = useRef(isConnected);
	isConnectedRef.current = isConnected;
	const logoutRef = useRef(logout);
	logoutRef.current = logout;

	// Track whether the iframe has signalled ready; messages posted before
	// view:ready are discarded to avoid delivering events to an uninitialised app
	const readyRef = useRef(false);

	// ---- Post helper -----------------------------------------------------------

	/**
	 * Posts a typed `ShellToIframeMsg` to the iframe's content window.
	 * Silently no-ops if the iframe ref has no attached content window.
	 *
	 * @param msg - The typed message to post.
	 */
	const post = useCallback((msg: ShellToIframeMsg) => {
		// Resolve the iframe's contentWindow; may be null if the element is unmounted
		const win = iframeRef.current?.contentWindow;
		// Post using the shell's origin — the iframe is served from the same origin
		// in production. Using a specific origin instead of '*' prevents messages
		// from leaking to unexpected frames.
		if (win) win.postMessage(msg, window.location.origin);
	}, [iframeRef]);

	// ---- Send shell:init -------------------------------------------------------

	/**
	 * Assembles and posts the `shell:init` bootstrap message to the iframe.
	 *
	 * Reads the current CSS tokens from the DOM at call time (not at hook
	 * registration time) so the snapshot is always fresh.  Uses refs for
	 * `authUser` and `isConnected` for the same reason.
	 */
	const sendInit = useCallback(() => {
		post({
			type: 'shell:init',
			// Snapshot current --rr-* design tokens from the DOM at this moment
			theme: readCssTokens(),
			// Use the ref to get the latest auth user without depending on the closure
			user: authUserRef.current,
			// Use the ref to get the latest connection state without stale closure risk
			isConnected: isConnectedRef.current,
			// Cast the full ShellApiConfig to the wire-safe Record shape
			apiConfig: apiConfig as Record<string, string | undefined>,
		});
	}, [post, apiConfig]);

	// Keep a ref to sendInit so the inbound message handler always calls the
	// latest version even though it was registered only once
	const sendInitRef = useRef(sendInit);
	sendInitRef.current = sendInit;

	// ---- Handle messages from iframe -------------------------------------------

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			// Ignore messages that did not originate from our managed iframe
			if (e.source !== iframeRef.current?.contentWindow) return;
			const msg = e.data;
			switch (msg?.type) {
				case 'view:ready':
					// Mark the iframe as ready so future connectionManager forwarding is enabled
					readyRef.current = true;
					// Immediately send the bootstrap init message via the latest sendInit ref
					sendInitRef.current();
					break;
				case 'shell:logout':
					// Delegate to the shell's logout flow (Zitadel PKCE end-session)
					logoutRef.current?.();
					break;
				case 'shell:openTab':
					// Translate the iframe's openTab request into a window CustomEvent
					// that the shell's tab manager listens for
					window.dispatchEvent(new CustomEvent('shell:openSingleton', {
						detail: { viewType: msg.viewType, label: msg.label },
					}));
					break;
			}
		};
		// Register on the parent window so messages from the iframe bubble up here
		window.addEventListener('message', handler);
		// Remove the listener when the hook's component unmounts
		return () => window.removeEventListener('message', handler);
	}, [iframeRef]);

	// ---- Forward connectionManager events to iframe -------------------------------------

	useEffect(() => {
		// Subscribe to every shell-wide event that the iframe protocol defines.
		// Each subscription checks readyRef before posting so events emitted before
		// view:ready are silently dropped rather than queued.
		const unsubs = [
			// Forward theme change events so the iframe can update its CSS tokens
			ConnectionManager.getInstance().on('shell:themeChange', ({ tokens }) => {
				if (readyRef.current) post({ type: 'shell:themeChange', tokens });
			}),
			// Notify the iframe when the WebSocket reconnects
			ConnectionManager.getInstance().on('shell:connected', () => {
				if (readyRef.current) post({ type: 'shell:connectionChange', isConnected: true });
			}),
			// Notify the iframe when the WebSocket disconnects
			ConnectionManager.getInstance().on('shell:disconnected', () => {
				if (readyRef.current) post({ type: 'shell:connectionChange', isConnected: false });
			}),
			// Forward new auth user after a successful login
			ConnectionManager.getInstance().on('shell:login', ({ user }) => {
				if (readyRef.current) post({ type: 'shell:login', user });
			}),
			// Notify the iframe when the user logs out (shell-initiated)
			ConnectionManager.getInstance().on('shell:logout', () => {
				if (readyRef.current) post({ type: 'shell:logout' });
			}),
			// Forward raw server WebSocket events so the iframe can react to them
			ConnectionManager.getInstance().on('shell:event', ({ event }) => {
				if (readyRef.current) post({ type: 'shell:event', event });
			}),
			// Forward view activation events so the iframe can restore its viewport
			ConnectionManager.getInstance().on('shell:viewActivated', ({ viewId }) => {
				if (readyRef.current) post({ type: 'shell:viewActivated', viewId });
			}),
		];
		// Return a cleanup that unsubscribes all bus listeners when the component unmounts
		return () => unsubs.forEach((u) => u());
	}, [post]);
}
