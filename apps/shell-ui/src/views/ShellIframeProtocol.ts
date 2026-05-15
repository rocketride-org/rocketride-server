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
// SHELL ↔ IFRAME POSTMESSAGE PROTOCOL — typed constants, no logic
// =============================================================================
//
// Shell → Iframe messages are sent automatically by useShellEvents().
// Iframe → Shell messages are handled automatically by useShellEvents().
//
// App-specific messages (project:load, project:contentChanged, etc.) are
// defined and handled in their own providers — not here.
// =============================================================================

import type { ConnectResult } from 'rocketride';

// =============================================================================
// SHELL → IFRAME
// =============================================================================

/**
 * Sent by the shell to an iframe immediately after the iframe posts `view:ready`.
 *
 * Bootstraps the iframe's initial state: current CSS theme tokens, the
 * authenticated user (or null), the WebSocket connection status, and all
 * runtime API config values (RR_* keys).
 */
export interface ShellInitMsg {
	type: 'shell:init';
	theme: Record<string, string>;
	user: ConnectResult | null;
	isConnected: boolean;
	apiConfig: Record<string, string | undefined>;
}

/**
 * Sent by the shell whenever the active CSS theme changes.
 *
 * The iframe should apply the new token map to its document root so that
 * its visuals remain consistent with the shell's theme.
 */
export interface ShellThemeChangeMsg {
	type: 'shell:themeChange';
	tokens: Record<string, string>;
}

/**
 * Sent by the shell when the RocketRide WebSocket connection opens or closes.
 *
 * The iframe can use this to enable/disable features that require a live
 * server connection.
 */
export interface ShellConnectionChangeMsg {
	type: 'shell:connectionChange';
	isConnected: boolean;
}

/**
 * Sent by the shell when a user successfully authenticates.
 *
 * Contains the full `ConnectResult` so the iframe can update any auth-
 * dependent UI (e.g. user display name, permissions checks).
 */
export interface ShellLoginMsg {
	type: 'shell:login';
	user: ConnectResult;
}

/**
 * Sent by the shell when the current user logs out.
 *
 * The iframe should clear any cached auth state and render an unauthenticated
 * view or redirect to the login screen.
 */
export interface ShellLogoutMsg {
	type: 'shell:logout';
}

/**
 * Wraps a raw server WebSocket event forwarded from the RocketRide client.
 *
 * The `event` field is typed as `unknown` because the shape depends on
 * the server node that emitted it; each iframe is expected to discriminate
 * on `event.type` or a similar field.
 */
export interface ServerEventMsg {
	type: 'shell:event';
	event: unknown;
}

/**
 * Sent by the shell when a view tab becomes the active (foreground) tab.
 *
 * The iframe uses `viewId` to determine whether the activated tab is its own,
 * allowing it to trigger re-layouts or deferred rendering that requires
 * non-zero dimensions (e.g. canvas viewport restore).
 */
export interface ShellViewActivatedMsg {
	type: 'shell:viewActivated';
	viewId: string;
}

/**
 * Discriminated union of every message the shell can post to an iframe.
 *
 * `useShellEvents` constructs and sends these via `contentWindow.postMessage`.
 * Iframe apps receive them in their own `window.addEventListener('message', ...)` handler.
 */
export type ShellToIframeMsg =
	| ShellInitMsg
	| ShellThemeChangeMsg
	| ShellConnectionChangeMsg
	| ShellLoginMsg
	| ShellLogoutMsg
	| ServerEventMsg
	| ShellViewActivatedMsg;

// =============================================================================
// IFRAME → SHELL
// =============================================================================

/**
 * Posted by an iframe to the parent shell as soon as the iframe's app code
 * has mounted and is ready to receive `shell:init`.
 *
 * The shell's `useShellEvents` hook listens for this message and responds
 * with a `ShellInitMsg` containing the current theme, user, and config.
 */
export interface ViewReadyMsg {
	type: 'view:ready';
}

/**
 * Posted by an iframe after it has fully processed `shell:init` and
 * rendered its initial content.
 *
 * The shell uses this as the signal to make the iframe visible (lifting the
 * `visibility:hidden` guard that prevents a theme-flash on load).
 */
export interface ViewInitializedMsg {
	type: 'view:initialized';
}

/**
 * Posted by an iframe to request a logout from within the iframe context.
 *
 * `useShellEvents` intercepts this and delegates to the shell's `useLogout` hook,
 * which handles the full Zitadel PKCE logout flow.
 */
export interface IframeShellLogoutMsg {
	type: 'shell:logout';
}

/**
 * Posted by an iframe to ask the shell to open a singleton tab.
 *
 * `useShellEvents` converts this into a `shell:openSingleton` CustomEvent on
 * `window`, which the shell's tab manager picks up and handles.
 */
export interface IframeOpenTabMsg {
	type: 'shell:openTab';
	viewType: string;
	label: string;
}

/**
 * Discriminated union of every message an iframe can post to the parent shell.
 *
 * `useShellEvents` filters incoming `MessageEvent`s to those from the managed
 * iframe and discriminates on `msg.type` to route each message.
 */
export type IframeToShellMsg =
	| ViewReadyMsg
	| ViewInitializedMsg
	| IframeShellLogoutMsg
	| IframeOpenTabMsg;
