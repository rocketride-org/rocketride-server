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
 * Task failures carry a machine-readable code (#2097).
 *
 * `DAPException` exposes `code` / `hint` from the server packet, and
 * `DataPipe.open()` keeps the server's message as the message while putting the
 * developer checklist in `hint`.
 */

import { DataPipe, RocketRideClient } from '../src/client/client';
import { DAPException, PipeException } from '../src/client/exceptions';
import type { Question } from '../src/client/schema/Question';

/** A client stub: enough surface for DataPipe.open(), no transport. */
function stubClient(response: Record<string, unknown>): RocketRideClient {
	return {
		buildRequest: (command: string, extra: Record<string, unknown>) => ({ command, ...extra }),
		request: async () => response,
		didFail: (r: Record<string, unknown>) => r.success === false,
	} as unknown as RocketRideClient;
}

/** Open a pipe against a stub that fails, and return the exception it threw. */
async function openAndCatch(response: Record<string, unknown>): Promise<PipeException> {
	const pipe = new DataPipe(stubClient(response), 'tk_gone');
	try {
		await pipe.open();
	} catch (e) {
		return e as PipeException;
	}
	throw new Error('expected open() to reject');
}

const notRunning = { success: false, message: 'Your pipeline is not running', code: 'TASK_NOT_REGISTERED' };

describe('task error codes', () => {
	it('exposes code and hint from the server packet', () => {
		const e = new PipeException({ message: 'Your pipeline is not running', code: 'TASK_NOT_REGISTERED', hint: 'Common causes:\n- ...' });

		expect(e.message).toBe('Your pipeline is not running');
		expect(e.code).toBe('TASK_NOT_REGISTERED');
		expect(e.hint).toMatch(/^Common causes:/);
	});

	it('leaves code and hint absent when the packet has neither', () => {
		const e = new DAPException({ message: 'boom' });

		expect(e.code).toBeUndefined();
		expect(e.hint).toBeUndefined();
		expect('code' in JSON.parse(JSON.stringify(e))).toBe(false);
	});

	it('ignores a non-string code', () => {
		const e = new DAPException({ message: 'boom', code: 42 });

		expect(e.code).toBeUndefined();
	});

	it('open() keeps the server message and moves the checklist to hint', async () => {
		const err = await openAndCatch({ success: false, message: 'Your pipeline is not running', code: 'TASK_NOT_REGISTERED' });

		expect(err).toBeInstanceOf(PipeException);
		expect(err.message).toBe('Your pipeline is not running');
		expect(err.message).not.toMatch(/Common causes/);
		expect(err.code).toBe('TASK_NOT_REGISTERED');
		expect(err.hint).toMatch(/^Common causes:/);
	});

	it('falls back to a generic message when the server sends none', async () => {
		const err = await openAndCatch({ success: false });

		expect(err.message).toBe('Failed to open a data pipe.');
		expect(err.code).toBeUndefined();
		expect(err.hint).toMatch(/^Common causes:/);
	});
});

describe('RocketRideClient.chat() failure', () => {
	/** A real client whose pipe open() always fails with the given DAP response. */
	function clientThatFailsOpen(response: Record<string, unknown>): RocketRideClient {
		const client = new RocketRideClient({ env: {} });
		const stub = client as unknown as Record<string, unknown>;
		stub.buildRequest = () => ({ seq: 1, type: 'request', command: 'rrext_process' });
		stub.request = async () => response;
		stub.didFail = (r: Record<string, unknown>) => r.success === false;
		return client;
	}

	/** Run chat() against a stub and return whatever it threw. */
	async function chatAndCatch(client: RocketRideClient, question: Question): Promise<unknown> {
		try {
			await client.chat({ token: 'tk_dead', question });
		} catch (err) {
			return err;
		}
		throw new Error('expected chat() to reject');
	}

	it('rethrows the typed PipeException so chat callers keep code and hint', async () => {
		const caught = await chatAndCatch(clientThatFailsOpen(notRunning), {} as Question);

		expect(caught).toBeInstanceOf(PipeException);
		const e = caught as PipeException;
		expect(e.message).toBe('Your pipeline is not running');
		expect(e.code).toBe('TASK_NOT_REGISTERED');
		expect(e.hint).toContain('Common causes:');
	});

	it('still normalises a non-DAP failure to a plain Error', async () => {
		const caught = await chatAndCatch(clientThatFailsOpen(notRunning), undefined as unknown as Question);

		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(DAPException);
		expect((caught as Error).message).toBe('Question cannot be empty');
	});
});
