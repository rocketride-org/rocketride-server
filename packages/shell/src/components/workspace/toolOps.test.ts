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

// Tests for the tool op-call mechanism: opt-in correlation, reply-iff-tracked,
// error and timeout propagation, and reply claiming when several frame
// clients share the broadcast reply path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolController, createToolOpServer, asToolCallMessage, asToolReplyMessage } from './toolOps';
import type { ToolOpMap, ToolOpSpec } from './toolOps';

type Peer = { post: (message: unknown) => void; subscribe: (cb: (message: unknown) => void) => () => void };

/**
 * An in-memory frame↔controller peer pair with the hosts' asynchronous
 * delivery semantics (each post lands on a fresh macrotask) and the
 * broadcast property of the real relays: every frame-side subscriber sees
 * every controller-side post (replies included).
 */
function peerPair(): { frame: Peer; controller: Peer } {
	const frameSubs = new Set<(m: unknown) => void>();
	const controllerSubs = new Set<(m: unknown) => void>();
	const deliver = (subs: Set<(m: unknown) => void>, message: unknown) => {
		setTimeout(() => {
			for (const cb of subs) cb(message);
		}, 0);
	};
	return {
		frame: {
			post: (message) => deliver(controllerSubs, message),
			subscribe: (cb) => {
				frameSubs.add(cb);
				return () => frameSubs.delete(cb);
			},
		},
		controller: {
			post: (message) => deliver(frameSubs, message),
			subscribe: (cb) => {
				controllerSubs.add(cb);
				return () => controllerSubs.delete(cb);
			},
		},
	};
}

/** The test tool's op map — the protocol-map pattern apps use. */
interface TestOps extends ToolOpMap {
	'test.echo': ToolOpSpec<{ text: string }, string>;
	'test.fail': ToolOpSpec<undefined, never>;
	'test.unknown': ToolOpSpec<undefined, never>;
	'test.slow': ToolOpSpec<undefined, string>;
}

test('a tracked call round-trips through a plain handler', async () => {
	const { frame, controller: ctrlPeer } = peerPair();
	const server = createToolOpServer<TestOps>(ctrlPeer);
	server.serve('test.echo', async ({ text }) => `echo:${text}`);
	const call = createToolController<TestOps>(frame);

	assert.equal(await call('test.echo', { text: 'hi' }), 'echo:hi');
	server.dispose();
});

test('a handler error becomes the caller rejection, message intact', async () => {
	const { frame, controller: ctrlPeer } = peerPair();
	const server = createToolOpServer<TestOps>(ctrlPeer);
	server.serve('test.fail', async () => {
		throw new Error('column does not exist');
	});
	const call = createToolController<TestOps>(frame);

	await assert.rejects(call('test.fail', undefined), /column does not exist/);
	server.dispose();
});

test('an unserved op rejects instead of hanging', async () => {
	const { frame, controller: ctrlPeer } = peerPair();
	const server = createToolOpServer<TestOps>(ctrlPeer);
	const call = createToolController<TestOps>(frame);

	await assert.rejects(call('test.unknown', undefined), /No handler serves 'test.unknown'/);
	server.dispose();
});

test('a timeout rejects with an answer-not-execution error; the late reply is dropped silently', async () => {
	const { frame, controller: ctrlPeer } = peerPair();
	const server = createToolOpServer<TestOps>(ctrlPeer);
	let release!: () => void;
	server.serve('test.slow', () => new Promise<string>((resolve) => (release = () => resolve('late'))));
	const call = createToolController<TestOps>(frame);

	await assert.rejects(call('test.slow', undefined, { timeoutMs: 20 }), /may still be executing/);
	// The handler finishes afterwards; its reply finds no pending entry and
	// must be ignored (no unhandled rejection, no resurrection).
	release();
	await new Promise((resolve) => setTimeout(resolve, 10));
	server.dispose();
});

test('each client claims only its own replies off the shared broadcast', async () => {
	const { frame, controller: ctrlPeer } = peerPair();
	const server = createToolOpServer<TestOps>(ctrlPeer);
	server.serve('test.echo', async ({ text }) => `echo:${text}`);
	const clientA = createToolController<TestOps>(frame);
	const clientB = createToolController<TestOps>(frame);

	const [a, b] = await Promise.all([clientA('test.echo', { text: 'A' }), clientB('test.echo', { text: 'B' })]);
	assert.equal(a, 'echo:A');
	assert.equal(b, 'echo:B');
	server.dispose();
});

test('a plain channel EVENT runs the same handler and produces NO reply', async () => {
	const { frame, controller: ctrlPeer } = peerPair();
	const server = createToolOpServer<TestOps>(ctrlPeer);
	const seen: unknown[] = [];
	server.serve('test.echo', async (args) => {
		seen.push(args);
		return 'ignored';
	});
	const strays: unknown[] = [];
	frame.subscribe((message) => {
		if (asToolReplyMessage(message)) strays.push(message);
	});

	// The uncorrelated path: the shell channel's event envelope, no id.
	frame.post({ __rrtool: 'event', name: 'test.echo', payload: { via: 'event' } });
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(seen, [{ via: 'event' }]);
	assert.equal(strays.length, 0);
	server.dispose();
});

test('unserve removes exactly its handler; dispose silences the server', async () => {
	const { frame, controller: ctrlPeer } = peerPair();
	const server = createToolOpServer<TestOps>(ctrlPeer);
	const unserve = server.serve('test.echo', async ({ text }) => `one:${text}`);
	unserve();
	const call = createToolController<TestOps>(frame);
	await assert.rejects(call('test.echo', { text: 'x' }, { timeoutMs: 50 }), /No handler serves/);

	server.serve('test.echo', async ({ text }) => `two:${text}`);
	server.dispose();
	// Disposed server: the call never answers at all — only the timeout fires.
	await assert.rejects(call('test.echo', { text: 'y' }, { timeoutMs: 30 }), /did not answer within/);
});

test('wire guards narrow calls and replies and reject the other kinds', () => {
	assert.ok(asToolCallMessage({ __rrtool: 'call', id: '1', op: 'x' }));
	assert.ok(asToolReplyMessage({ __rrtool: 'reply', id: '1', ok: true }));
	assert.equal(asToolCallMessage({ __rrtool: 'state', topic: 't', snapshot: {} }), null);
	assert.equal(asToolCallMessage({ __rrtool: 'reply', id: '1', ok: true }), null);
	assert.equal(asToolReplyMessage({ __rrtool: 'event', name: 'n' }), null);
	assert.equal(asToolReplyMessage(null), null);
	assert.equal(asToolCallMessage('call'), null);
});
