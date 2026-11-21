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

/**
 * node:test suite for the canvas gate: the canvas shows once the editor holds
 * a catalog; until then the view names the reason (a refused sign-in, no
 * connection, a server that sent no catalog) or says it is still loading.
 * Run via `./builder shared:test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalogGate } from './catalogGate';
import type { IGateConnection } from './catalogGate';

// =============================================================================
// Fixtures
// =============================================================================

/** A connected client with credentials and no failure. */
const CONNECTED: IGateConnection = { connected: true, connecting: false, hasCredentials: true, authRefused: false };

/** A client with credentials that is not connected and not trying. */
const DOWN: IGateConnection = { connected: false, connecting: false, hasCredentials: true, authRefused: false };

// =============================================================================
// The canvas shows
// =============================================================================

test('a held catalog opens the canvas, whatever the connection says', () => {
	assert.equal(catalogGate(3, CONNECTED, { services: { llm_openai: {} } }), null);
	assert.equal(catalogGate(3, { ...DOWN, authRefused: true, lastError: 'Invalid or revoked API key' }, null), null);
});

// =============================================================================
// No server to ask
// =============================================================================

test('a refused sign-in says so, names the server message and offers Settings', () => {
	const gate = catalogGate(0, { ...DOWN, authRefused: true, lastError: 'Invalid or revoked API key.' }, { services: {}, servicesError: 'Not connected' });

	assert.equal(gate?.title, 'Sign-in required');
	assert.match(gate?.description ?? '', /\(Invalid or revoked API key\)\./);
	assert.equal(gate?.offerSettings, true);
});

test('a refused sign-in wins over a reconnect attempt', () => {
	const gate = catalogGate(0, { ...DOWN, connecting: true, authRefused: true }, null);

	assert.equal(gate?.title, 'Sign-in required');
});

test('a bridged realm that sees only the error still shows it, with Settings', () => {
	// The VS Code webview: the root's AUTH_FAILED arrives as "not connected"
	// with the server's message as the last error.
	const gate = catalogGate(0, { ...DOWN, lastError: 'Invalid or revoked API key' }, null);

	assert.equal(gate?.title, 'Not connected');
	assert.match(gate?.description ?? '', /The last attempt failed: Invalid or revoked API key\./);
	assert.equal(gate?.offerSettings, true);
});

test('a connection attempt under way says it is connecting, with the last failure', () => {
	const fresh = catalogGate(0, { ...DOWN, connecting: true }, null);
	const retrying = catalogGate(0, { ...DOWN, connecting: true, lastError: 'ECONNREFUSED' }, null);

	assert.equal(fresh?.title, 'Connecting to the server');
	assert.equal(fresh?.offerSettings, false);
	assert.match(retrying?.description ?? '', /The last attempt failed: ECONNREFUSED\./);
	assert.equal(retrying?.offerSettings, true);
});

test('no connection set up says so and offers Settings', () => {
	const gate = catalogGate(0, { connected: false, connecting: false, hasCredentials: false, authRefused: false }, null);

	assert.equal(gate?.title, 'Not connected');
	assert.match(gate?.description ?? '', /no connection is set up/);
	assert.equal(gate?.offerSettings, true);
});

test('a dropped connection with no message says only that the canvas needs a server', () => {
	const gate = catalogGate(0, DOWN, null);

	assert.equal(gate?.title, 'Not connected');
	assert.doesNotMatch(gate?.description ?? '', /last attempt/);
});

// =============================================================================
// The server answered without a catalog
// =============================================================================

test('a catalog the server failed to send is the diagnostic cause, with Settings', () => {
	const gate = catalogGate(0, CONNECTED, { services: {}, servicesError: 'HTTP 401: invalid API key' });

	assert.equal(gate?.title, 'The canvas cannot open');
	assert.match(gate?.description ?? '', /HTTP 401: invalid API key/);
	assert.doesNotMatch(gate?.description ?? '', /services-catalog\.json/);
	assert.equal(gate?.offerSettings, true);
});

test('an empty catalog points at the engine, without Settings', () => {
	const gate = catalogGate(0, CONNECTED, { services: {} });

	assert.match(gate?.description ?? '', /--trace=Services/);
	assert.equal(gate?.offerSettings, false);
});

// =============================================================================
// Still loading
// =============================================================================

test('connected with no reply yet is loading', () => {
	const gate = catalogGate(0, CONNECTED, null);

	assert.equal(gate?.title, 'Loading the node definitions');
	assert.equal(gate?.offerSettings, false);
});

test('a reply from before the connection came up is loading, not a failure', () => {
	const gate = catalogGate(0, CONNECTED, { services: {}, servicesError: 'Not connected' });

	assert.equal(gate?.title, 'Loading the node definitions');
});
