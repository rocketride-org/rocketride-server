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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,

// =============================================================================
// EXPLORER DEV TOOL — READINESS (waiting is never "disconnected")
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineReadiness, engineStatus, frameStatus } from './readiness';

describe('engineStatus — the controller gates engine requests on the realm\'s own client and connection', () => {
	it('no client is waiting, whatever isConnected says; a client that is not up is disconnected; both is ready', () => {
		assert.equal(engineStatus({ client: null, isConnected: false }), 'waiting');
		assert.equal(engineStatus({ client: undefined, isConnected: true }), 'waiting');
		assert.equal(engineStatus({ client: {}, isConnected: false }), 'disconnected');
		assert.equal(engineStatus({ client: {}, isConnected: true }), 'ready');
	});
});

describe('frameStatus — tri-state: no host snapshot yet is waiting, never disconnected', () => {
	it('derives from host:connection first, then the controller', () => {
		assert.equal(frameStatus(undefined, 'ready'), 'waiting');
		assert.equal(frameStatus(null, 'unanswered'), 'waiting');
		assert.equal(frameStatus(false, 'ready'), 'disconnected');
		assert.equal(frameStatus(true, 'ready'), 'connected');
		assert.equal(frameStatus(true, 'summoning'), 'waiting');
		assert.equal(frameStatus(true, 'unanswered'), 'controller-unavailable');
	});
});

describe('createEngineReadiness', () => {
	it('starts waiting, notifies only on a change of status, and stops notifying after unsubscribe', () => {
		const engine = createEngineReadiness();
		const seen: string[] = [];
		const off = engine.subscribe((status) => seen.push(status));
		assert.equal(engine.status(), 'waiting');
		assert.equal(engine.isReady(), false);
		engine.set({ client: {}, isConnected: false });
		engine.set({ client: {}, isConnected: false });
		engine.set({ client: {}, isConnected: true });
		assert.equal(engine.isReady(), true);
		off();
		engine.set({ client: null, isConnected: false });
		assert.deepEqual(seen, ['disconnected', 'ready']);
		assert.equal(engine.status(), 'waiting');
	});

	it('takes its initial status from the facts known at mount', () => {
		assert.equal(createEngineReadiness({ client: {}, isConnected: true }).status(), 'ready');
	});
});
