/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { KEY_REQUIRED_MESSAGE } from '../../connection/errors';
import { failureCopy } from './connectionFailureCopy';

test('a key-required auth failure shows API-key guidance, not session expiry', () => {
	const copy = failureCopy({ kind: 'auth', lastError: KEY_REQUIRED_MESSAGE, errorKind: 'session' });
	assert.equal(copy.title, 'API key required');
	assert.equal(copy.message, KEY_REQUIRED_MESSAGE);
});

test('other auth failures keep the session-expired copy', () => {
	const copy = failureCopy({ kind: 'auth', lastError: 'Your session has expired. Please sign in again.', errorKind: 'session' });
	assert.equal(copy.title, 'Session expired');
});

test('network and oauth-callback failures keep their copy', () => {
	assert.equal(failureCopy({ kind: 'network', lastError: 'x' }).title, 'Connection lost');
	assert.equal(failureCopy({ kind: 'auth', lastError: 'denied', errorKind: 'oauth-callback' }).title, 'Sign-in failed');
});
