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
// useIframeBridge — T73 (E7): the inbound handler also requires the shell's own origin
// =============================================================================
//
// Plan section 3.3 (`useIframeBridge.ts`): "The handler also requires
// `e.origin === window.location.origin`. This is unconditional and inert,
// because `post` already targets that origin." A frame that navigated to a
// foreign origin keeps its `contentWindow` (so `e.source` still matches) but
// its messages carry the foreign origin: they must not reach the handler.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { installDom, render } from '../test/domHarness';
import { useIframeBridge } from './useIframeBridge';

/** Mounts a component using the hook over one `<iframe>`; returns the frame's window and its `postMessage` calls. */
async function mount() {
	const dom = installDom('http://localhost:5565/');
	const posted: Array<{ message: Record<string, unknown>; targetOrigin: unknown }> = [];
	let frame: HTMLIFrameElement | null = null;
	function Host(): React.ReactElement {
		const ref = React.useRef<HTMLIFrameElement>(null);
		useIframeBridge(ref as React.RefObject<HTMLIFrameElement>);
		return React.createElement('iframe', {
			ref: (el: HTMLIFrameElement | null) => {
				frame = el;
				(ref as React.MutableRefObject<HTMLIFrameElement | null>).current = el;
			},
		});
	}
	const tree = await render(React.createElement(Host));
	// happy-dom gives an iframe without a loaded document no window: stand in a fake one (the hook only reads `contentWindow` and posts to it).
	const win = { postMessage: (message: Record<string, unknown>, targetOrigin: unknown) => void posted.push({ message, targetOrigin }) };
	Object.defineProperty(frame!, 'contentWindow', { value: win, configurable: true });
	const send = (origin: string, data: unknown, source: unknown = win): void => {
		dom.window.dispatchEvent(new (dom.window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data, origin, source: source as MessageEventSource }) as never);
	};
	return {
		posted,
		send,
		win,
		async done() {
			await tree.unmount();
			dom.cleanup();
		},
	};
}

test('T73 a view:ready from the frame window at the shell origin gets shell:init (control)', async () => {
	const h = await mount();
	try {
		h.send('http://localhost:5565', { type: 'view:ready' });
		assert.equal(h.posted.filter((p) => p.message.type === 'shell:init').length, 1, 'same origin + matching source is served');
		assert.equal(h.posted[0]?.targetOrigin, 'http://localhost:5565');
	} finally {
		await h.done();
	}
});

test('T73 E7: a view:ready from the frame window at a FOREIGN origin is ignored', async () => {
	const h = await mount();
	try {
		for (const origin of ['http://evil.example', 'http://localhost:5566', 'https://localhost:5565', 'null', '', 'http://a1234567890123456789012345.apps.localhost:5565']) {
			h.send(origin, { type: 'view:ready' });
		}
		assert.deepEqual(
			h.posted.map((p) => p.message.type),
			[],
			'no shell:init (the app origin of an isolated frame must never be answered by the same-origin bridge)'
		);
	} finally {
		await h.done();
	}
});

test('T73 E7: a shell:logout from a foreign origin does not run the logout flow, and the ready flag stays false', async () => {
	const h = await mount();
	try {
		h.send('http://evil.example', { type: 'view:ready' });
		h.send('http://evil.example', { type: 'shell:logout' });
		// If the foreign ready had been accepted, a later shell-wide event would be forwarded.
		const { ConnectionManager } = await import('../connection/connection');
		ConnectionManager.getInstance().emit('shell:connected', {} as never);
		assert.deepEqual(
			h.posted.map((p) => p.message.type),
			[],
			'events are not forwarded to a frame whose ready came from a foreign origin'
		);
	} finally {
		await h.done();
	}
});
