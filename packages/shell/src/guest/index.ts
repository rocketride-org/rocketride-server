// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// GUEST RUNTIME — the isolated app frame's host (PR2b, plan §3.4, §4.1)
// =============================================================================
//
// Loaded by `boot.ts` after the guest flag is set. It posts `rr:frame:ready`
// to each shell origin of `<meta name="rr-shell-origins">`, accepts exactly
// one `rr:bridge:init` (`acceptInit.ts`), and then:
//   • attaches this realm's bus to the root over the init's port;
//   • puts the ConnectionManager in guest mode (no socket, no credential);
//   • loads the app's `AppDescriptor` from `entryPrefix` with Module
//     Federation (chunk URLs follow the current prefix, `mfPlugin.ts`);
//   • renders the app with `{isConnected, identity}`;
//   • asks the root for one frame-token refresh 120 s before expiry.
// Everything the guest knows about itself comes from the init.
// =============================================================================

import React from 'react';
import { createRoot } from 'react-dom/client';
import { loadRemote, registerPlugins, registerRemotes } from '@module-federation/runtime';
import { ConnectionManager } from '../connection/connection';
import { attachRealmToRoot } from '../ops/busBridge';
import { portEndpoint } from '../isolation/portEndpoint';
import type { IPortLike } from '../isolation/portEndpoint';
import type { AppDescriptor } from '../components/workspace/types';
import { createInitAcceptor, parseShellOrigins, readyMessages } from './acceptInit';
import { createGuestMfPlugin } from './mfPlugin';
import { startFrameRefresh } from './refresh';

function mountPoint(): HTMLElement {
	const existing = document.getElementById('root');
	if (existing) return existing;
	const div = document.createElement('div');
	div.id = 'root';
	div.style.height = '100%';
	document.body.appendChild(div);
	return div;
}

function fail(text: string): void {
	mountPoint().textContent = text;
}

async function start(init: import('../isolation/types').BridgeInit, port: IPortLike): Promise<void> {
	const cm = ConnectionManager.getInstance();
	const attachment = attachRealmToRoot(cm.ops(), portEndpoint(port));
	cm.setRetainedPort(attachment.retained);
	cm.enterGuestMode(init);

	let prefix = init.entryPrefix;
	registerPlugins([createGuestMfPlugin(() => prefix) as never]);
	registerRemotes([{ name: init.moduleId, entry: `${prefix}remoteEntry.js` }]);
	const loaded = (await loadRemote(`${init.moduleId}/AppDescriptor`)) as { default?: AppDescriptor } | null;
	const descriptor = loaded?.default;
	if (!descriptor || typeof descriptor.app !== 'function') {
		fail('This app could not be loaded.');
		return;
	}

	const root = createRoot(mountPoint());
	const App = descriptor.app;
	const render = (): void => root.render(React.createElement(App, { isConnected: cm.isConnected(), identity: cm.getAccountInfo() ?? null }));
	render();
	cm.on('shell:connected', render);
	cm.on('shell:disconnected', render);

	startFrameRefresh({
		expiresAt: init.expiresAt,
		now: () => Date.now(),
		request: async () => (await cm.request('shell.frameToken.refresh', {})) as { entryPrefix: string; expiresAt: number },
		setTimer: (cb, ms) => setTimeout(cb, ms),
		clearTimer: (timer) => clearTimeout(timer),
		apply: (next) => void (prefix = next),
		failed: () => fail('This session has ended. Reload the app to continue.'),
	});
}

const origins = parseShellOrigins(document.querySelector('meta[name="rr-shell-origins"]')?.getAttribute('content'));
const acceptor = createInitAcceptor({ origins, parent: window.parent });
const onMessage = (ev: MessageEvent): void => {
	const got = acceptor.accept({ source: ev.source, origin: ev.origin, data: ev.data, ports: ev.ports });
	if (!got) return;
	window.removeEventListener('message', onMessage);
	start(got.init, got.port as IPortLike).catch(() => fail('This app could not be loaded.'));
};
window.addEventListener('message', onMessage);
for (const { targetOrigin, message } of readyMessages(origins)) window.parent.postMessage(message, targetOrigin);
