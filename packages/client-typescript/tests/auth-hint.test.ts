import { afterEach, it as test, jest } from '@jest/globals';
import assert from 'node:assert/strict';
import { RocketRideClient } from '../src/client/client';
import { TransportWebSocket } from '../src/client/core/TransportWebSocket';
import { AuthenticationException } from '../src/client/exceptions/index';
import { hintFor } from '../src/cli/common';

afterEach(() => {
	jest.restoreAllMocks();
});

/** Log in with a credential against a mocked server answer; return the thrown error. */
async function loginError(auth: string, message: string): Promise<unknown> {
	jest.spyOn(TransportWebSocket.prototype, 'connect').mockResolvedValue();
	jest.spyOn(TransportWebSocket.prototype, 'disconnect').mockResolvedValue();
	const client = new RocketRideClient({ env: {}, persist: false });
	jest.spyOn(client, 'request').mockResolvedValue({ type: 'response', command: 'auth', seq: 1, request_seq: 0, success: false, message });
	try {
		await client.login(auth);
		return undefined;
	} catch (error) {
		return error;
	} finally {
		await client.detach();
	}
}

test('an empty credential keeps the message and sets the hint', async () => {
	const error = await loginError('', 'No authorization provided');
	assert.ok(error instanceof AuthenticationException);
	assert.equal(error.message, 'No authorization provided');
	assert.match(error.hint ?? '', /Set ROCKETRIDE_APIKEY or pass auth/);
	assert.match(error.hint ?? '', /rocketride login/);
});

test('a non-empty credential adds no hint', async () => {
	const error = await loginError('bad-key', 'No authorization provided');
	assert.ok(error instanceof AuthenticationException);
	assert.equal(error.message, 'No authorization provided');
	assert.equal(error.hint, undefined);
});

test('another message with an empty credential adds no hint', async () => {
	const error = await loginError('', 'Invalid API key');
	assert.ok(error instanceof AuthenticationException);
	assert.equal(error.message, 'Invalid API key');
	assert.equal(error.hint, undefined);
});

test('the CLI hint helper returns the error own hint first', () => {
	const error = new AuthenticationException({ message: 'Invalid API key', hint: 'Set the key.' });
	assert.equal(hintFor(error, 'http://x'), 'Set the key.');
});
