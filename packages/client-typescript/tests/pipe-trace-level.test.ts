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
 * A pipe's trace level is part of its transaction: given when the DataPipe is
 * created, sent on the open frame and on no later frame.
 */

import { DataPipe, RocketRideClient } from '../src/client/client';

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

/** The arguments of one recorded frame. */
const argumentsOf = (packet: Packet): Packet => packet.arguments as Packet;

describe('DataPipe trace level', () => {
	it('rides the open frame and no later frame', async () => {
		const { client, sent } = stubClient([
			{ success: true, body: { pipeId: 7 } },
			{ success: true, body: {} },
			{ success: true, body: {} },
		]);
		const pipe = new DataPipe(client, 'acme.docBrain', {}, 'text/plain', undefined, undefined, undefined, undefined, 'full');

		await pipe.open();
		await pipe.write(new TextEncoder().encode('hello'));
		await pipe.close();

		expect(sent.map((packet) => argumentsOf(packet).subcommand)).toEqual(['open', 'write', 'close']);
		expect(argumentsOf(sent[0]).pipelineTraceLevel).toBe('full');
		expect(sent.slice(1).every((packet) => !('pipelineTraceLevel' in argumentsOf(packet)))).toBe(true);
	});

	it('is absent from the open of a pipe given none', async () => {
		const { client, sent } = stubClient([{ success: true, body: { pipeId: 7 } }]);
		const pipe = new DataPipe(client, 'acme.docBrain', {}, 'text/plain');

		await pipe.open();

		expect('pipelineTraceLevel' in argumentsOf(sent[0])).toBe(false);
	});
});
