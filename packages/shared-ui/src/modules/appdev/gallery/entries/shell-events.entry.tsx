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
// SHELL EVENTS — GALLERY ENTRY (DOC-ONLY, HOOKS)
// =============================================================================

/** Doc-only gallery entry for the typed shell event bus and its event map. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Shell events gallery entry. */
export const shellEventsEntry: IGalleryEntry = {
	id: 'shell-events',
	name: 'Shell events',
	group: 'hooks',
	blurb: 'The typed platform event bus: every shell:* event in ShellEventMap, subscribed via useShellEvent and emitted on the ConnectionManager.',
	doc: `\`ShellEventMap\` is the closed catalog of SHARED platform events — app-private messages never enter it. Subscribe with \`useShellEvent(name, handler)\` (auto-cleanup, handler ref stays current without resubscribing); emit with \`ConnectionManager.getInstance().emit(name, payload)\`.

Server pushes arrive as \`shell:event\` carrying the raw DAP message — that is the one firehose for live data. \`useSubscriptions()\` is the convenience view over the account's desktop apps from \`ConnectResult.apps\`.

Press **ALT+D** to watch the bus live in the Debug panel.`,
	docNote: 'ShellEventMap is for shared platform events ONLY - never add app-private messages to it. Apps talk to themselves through their own channels.',
	code: `import { useShellEvent, ConnectionManager } from 'shell';

// Subscribe - typed payload, auto-cleanup on unmount:
useShellEvent('shell:event', ({ event }) => {
	if (event.type === 'apaext_billing') refreshLedger();
});
useShellEvent('shell:themeChange', ({ tokens }) => repaintCanvas(tokens));

// Emit - ask the shell to do something:
ConnectionManager.getInstance().emit('shell:switchApp', { appId: 'monitor' });`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'useShellEvent', type: '<K extends keyof ShellEventMap>(event: K, handler: (payload: ShellEventMap[K]) => void) => void', dir: 'out', note: 'Typed subscription with automatic cleanup; the handler ref stays current without resubscribing.' },
		{ name: 'useSubscriptions', type: '() => { desktopApps, isOnDesktop, getStatus }', dir: 'out', note: "The account's desktop apps from ConnectResult.apps, with memoized per-app status lookups." },
	],
	sections: [
		{
			label: 'Connection lifecycle',
			rows: [
				{ name: 'shell:connected / shell:disconnected', type: 'void / { reason, hasError }', dir: 'out', note: 'WebSocket handshake + auth succeeded / socket closed.' },
				{ name: 'shell:statusChange', type: 'ConnectionStatus', dir: 'out', note: 'Every state-machine transition, with retry/progress detail.' },
				{ name: 'shell:statusMessage', type: '{ message: string | null }', dir: 'out', note: 'Transient status-bar text; null clears it.' },
				{ name: 'shell:error', type: '{ error }', dir: 'out', note: 'Connection or operation failure.' },
			],
		},
		{
			label: 'Server data',
			rows: [
				{ name: 'shell:event', type: '{ event: DAPMessage }', dir: 'out', note: 'EVERY server push over the WebSocket - the one live-data firehose.' },
				{ name: 'shell:accountUpdate', type: 'ConnectResult', dir: 'out', note: 'Server-pushed account/subscription update.' },
				{ name: 'shell:servicesUpdated', type: '{ services, servicesError? }', dir: 'out', note: 'Service catalog fetched or refreshed.' },
				{ name: 'shell:appsUpdated', type: '{ apps: ShellAppEntry[] }', dir: 'out', note: 'App catalog changed (full replacement).' },
			],
		},
		{
			label: 'Auth',
			rows: [
				{ name: 'shell:login / shell:logout', type: '{ user: ConnectResult } / void', dir: 'out', note: 'Authentication succeeded / identity cleared.' },
				{ name: 'shell:loginRequest / shell:logoutRequest', type: '{ appId?, register? } / void', dir: 'in', note: 'UI-initiated sign-in / sign-out requests.' },
			],
		},
		{
			label: 'UI coordination',
			rows: [
				{ name: 'shell:switchApp', type: '{ appId }', dir: 'in', note: 'Switch the active app.' },
				{ name: 'shell:openOverlay', type: "{ id: 'account' | 'settings' | 'environment' }", dir: 'in', note: 'Open a shell overlay (guarded allowlist).' },
				{ name: 'shell:subscribe / shell:unsubscribe', type: '{ app, plan?, promo? } / { appId }', dir: 'in', note: 'Open checkout for a paid app / subscription cancelled.' },
				{ name: 'shell:myApps', type: 'void', dir: 'in', note: 'Navigate to the My Apps launcher.' },
				{ name: 'shell:themeChange', type: '{ tokens: Record<string, string> }', dir: 'out', note: 'Theme tokens changed - canvases repaint from these.' },
				{ name: 'shell:viewActivated / shell:sidebarCollapsing', type: '{ viewId } / void', dir: 'out', note: 'A view became active / the sidebar is starting to collapse.' },
			],
		},
		{
			label: 'App development',
			rows: [
				{ name: 'shell:manifestRefresh', type: '{ source }', dir: 'out', note: 'Server-side app manifest changed (dev overlay, publish, expiry).' },
				{ name: 'app:statusChanged', type: '{ appId, status, notes? }', dir: 'out', note: 'Marketplace review status changed.' },
				{ name: 'store:changed', type: '{ prefix, paths }', dir: 'out', note: 'Files changed under a watched store prefix.' },
			],
		},
	],
};
