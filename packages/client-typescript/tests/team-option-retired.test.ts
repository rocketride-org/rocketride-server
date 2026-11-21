/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The retired per-call team option — no server required (plan 11.1 B44).
 *
 * A rooted address names the rung now (`@<team>/...`, `=team/<tid>/...`). The
 * positional `team` slot of `pipe()`, `send()` and the `DataPipe` constructor
 * stays in the signature until the 2.0 floors let it go, and refuses any value
 * so a caller still writing the old form learns what to write instead of
 * landing on another rung. A rooted address rides the token slot unchanged.
 */

import { DataPipe, RocketRideClient } from '../src/client';
import { describe, it, expect } from '@jest/globals';

/** A detached client shell: prototype methods available, no socket. */
function makeClientShell(): { client: RocketRideClient; requests: Array<Record<string, unknown>> } {
	const requests: Array<Record<string, unknown>> = [];
	const client = Object.create(RocketRideClient.prototype) as RocketRideClient;
	const shell = client as unknown as Record<string, unknown>;
	shell.buildRequest = (command: string, fields: Record<string, unknown>) => ({ command, ...fields });
	shell.request = async (request: Record<string, unknown>) => {
		requests.push(request);
		return { success: true, body: { pipeId: 1, traceId: 't' } };
	};
	shell.didFail = () => false;
	shell.debugMessage = () => undefined;
	return { client, requests };
}

describe('the retired team option', () => {
	it('refuses a team in the DataPipe constructor, naming the rooted address', () => {
		const { client } = makeClientShell();
		expect(() => new DataPipe(client, 'acme.docBrain', {}, 'text/plain', undefined, undefined, 'team-1')).toThrow('team= is retired: write a rooted address');
	});

	it('refuses a team in pipe() and send() before any request leaves', async () => {
		const { client, requests } = makeClientShell();
		await expect(client.pipe('acme.docBrain', {}, 'text/plain', undefined, undefined, 'team-1')).rejects.toThrow('team= is retired');
		await expect(client.send('acme.docBrain', 'hi', {}, 'text/plain', undefined, 'team-1')).rejects.toThrow('team= is retired');
		expect(requests).toEqual([]);
	});

	it('opens a rooted address with the root in the token slot and no team argument', async () => {
		const { client, requests } = makeClientShell();
		const pipe = await client.pipe('@Production/acme.docBrain.webhook_1', {}, 'text/plain');
		await pipe.open();
		expect(requests).toHaveLength(1);
		expect(requests[0].token).toBe('@Production/acme.docBrain.webhook_1');
		expect(requests[0].arguments).not.toHaveProperty('team');
	});
});
