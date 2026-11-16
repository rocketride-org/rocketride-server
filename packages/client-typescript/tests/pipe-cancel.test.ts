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
 * `DataPipe.cancel()`: one `cancel` frame on the open pipe; the pipe stays open
 * for `close()`, and the write the cancel interrupted carries `TASK_CANCELLED`.
 */

import { DataPipe, RocketRideClient } from '../src/client/client';
import { PipeException } from '../src/client/exceptions';

type Packet = Record<string, unknown>;

/** A client stub that answers each request from a script and records what was sent. */
function stubClient(script: Packet[]): { client: RocketRideClient; sent: Packet[] } {
	const sent: Packet[] = [];
	const client = {
		buildRequest: (command: string, extra: Packet) => ({ command, ...extra }),
		request: async (request: Packet) => {
			sent.push(request);
			return script.shift() ?? { success: false, message: 'script exhausted' };
		},
		didFail: (r: Packet) => r.success === false,
	} as unknown as RocketRideClient;
	return { client, sent };
}

describe('DataPipe.cancel()', () => {
	it('sends one cancel frame on the open pipe and leaves it open', async () => {
		const { client, sent } = stubClient([
			{ success: true, body: { pipeId: 7 } },
			{ success: true, body: { pipeId: 7, cancelled: true } },
			{ success: true, body: {} },
		]);
		const pipe = new DataPipe(client, 'acme.docBrain', {}, 'text/plain', undefined, undefined, 'team-1');

		await pipe.open();
		await pipe.cancel();
		expect(pipe.isOpened).toBe(true);
		await pipe.close();

		expect(sent[1]).toEqual({
			command: 'rrext_process',
			arguments: { subcommand: 'cancel', pipeId: 7, team: 'team-1' },
			token: 'acme.docBrain',
		});
		expect((sent[2].arguments as Packet).subcommand).toBe('close');
	});

	it('refuses locally before open and after close, sending nothing', async () => {
		const { client, sent } = stubClient([{ success: true, body: { pipeId: 7 } }, { success: true, body: {} }]);
		const pipe = new DataPipe(client, 'tk');

		await expect(pipe.cancel()).rejects.toThrow('Pipe is not open');
		expect(sent).toHaveLength(0);

		await pipe.open();
		await pipe.close();
		await expect(pipe.cancel()).rejects.toThrow('Pipe is not open');
		expect(sent).toHaveLength(2);
	});

	it("raises the server's refusal as a PipeException", async () => {
		const { client } = stubClient([
			{ success: true, body: { pipeId: 7 } },
			{ success: false, message: 'Cancel pipe with id 7 is open for another request' },
		]);
		const pipe = new DataPipe(client, 'tk');
		await pipe.open();

		await expect(pipe.cancel()).rejects.toBeInstanceOf(PipeException);
	});

	it('the write a cancel interrupted carries the TASK_CANCELLED code', async () => {
		const { client } = stubClient([
			{ success: true, body: { pipeId: 7 } },
			{ success: false, message: 'Pipe 7: the request was cancelled', code: 'TASK_CANCELLED' },
		]);
		const pipe = new DataPipe(client, 'tk');
		await pipe.open();

		let caught: unknown;
		try {
			await pipe.write(new TextEncoder().encode('more'));
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(PipeException);
		expect((caught as PipeException).code).toBe('TASK_CANCELLED');
	});
});
