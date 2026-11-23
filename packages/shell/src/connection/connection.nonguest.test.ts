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
// T59 (control) — a non-guest bridged realm (VS Code) is unchanged
// =============================================================================
//
// The guest-mode change makes the constructor skip `installMirrorSubscriptions`
// only when the realm is a guest. A bridged realm that is not (the VS Code
// webview) must keep subscribing to the three mirror topics and keep following
// them. This control passes on the base and has to stay green.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionManager } from './connection';
import { createRetainedRegistry, localRetainedPort } from '../ops/retained';
import type { IRetainedPort } from '../ops/retained';

test('T59 a non-guest bridged realm still subscribes to shell:status, shell:account and shell:services and follows their snapshots', async () => {
	const cm = Reflect.construct(ConnectionManager, []) as ConnectionManager;
	const registry = createRetainedRegistry();
	const topics: string[] = [];
	const inner = localRetainedPort(registry);
	const port: IRetainedPort = {
		...inner,
		subscribe: (topic, cb) => {
			topics.push(topic);
			return inner.subscribe(topic, cb);
		},
	};
	cm.setRetainedPort(port);
	for (const topic of ['shell:status', 'shell:account', 'shell:services']) assert.ok(topics.includes(topic), `${topic} is subscribed`);
	registry.publish('shell:status', { connected: true, status: { state: 'connected', connectionMode: 'cloud' }, engineHttpUrl: 'http://engine.test' });
	await new Promise((resolve) => setTimeout(resolve, 30)); // retained delivery is asynchronous
	assert.equal(cm.isConnected(), true, 'the mirror still drives isConnected()');
	assert.equal(cm.getHttpUrl(), 'http://engine.test');
});
