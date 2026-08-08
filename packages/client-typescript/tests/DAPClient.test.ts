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

import { DAPClient } from '../src/client/core/DAPClient';
import { TransportBase } from '../src/client/core/TransportBase';
import type { DAPMessage } from '../src/client/types';

class ControlledTransport extends TransportBase {
	readonly sent: DAPMessage[] = [];
	sendGate?: Promise<void>;

	constructor() {
		super();
		this._connected = true;
	}

	async connect(): Promise<void> {
		this._connected = true;
	}

	async disconnect(): Promise<void> {
		this._connected = false;
	}

	async send(message: DAPMessage): Promise<void> {
		this.sent.push(message);
		await this.sendGate;
	}

	async receive(message: DAPMessage): Promise<void> {
		await this._transportReceive(message);
	}

	async connected(info: string): Promise<void> {
		await this._transportConnected(info);
	}

	async disconnected(reason: string, hasError = true): Promise<void> {
		this._connected = false;
		await this._transportDisconnected(reason, hasError);
	}
}

class ObservableDAPClient extends DAPClient {
	readonly events: DAPMessage[] = [];
	readonly connections: string[] = [];
	readonly disconnections: string[] = [];

	constructor(transport: TransportBase, onDebugMessage?: (message: string) => void) {
		super('TEST', transport, { requestTimeout: 1_000, onDebugMessage });
	}

	bindTransport(transport: TransportBase): void {
		this._bindTransport(transport);
	}

	async onEvent(event: DAPMessage): Promise<void> {
		this.events.push(event);
	}

	async onConnected(info?: string): Promise<void> {
		this.connections.push(info ?? '');
		await super.onConnected(info);
	}

	async onDisconnected(reason?: string, hasError = false): Promise<void> {
		this.disconnections.push(`${reason ?? ''}:${hasError}`);
		await super.onDisconnected(reason, hasError);
	}
}

type RequestOutcome =
	| { status: 'resolved'; value: DAPMessage }
	| { status: 'rejected'; error: unknown };

function requestOutcome(promise: Promise<DAPMessage>): Promise<RequestOutcome> {
	return promise.then(
		(value) => ({ status: 'resolved' as const, value }),
		(error) => ({ status: 'rejected' as const, error }),
	);
}

async function settleSoon(promise: Promise<RequestOutcome>): Promise<RequestOutcome | { status: 'pending' }> {
	return Promise.race([
		promise,
		new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 25)),
	]);
}

function responseFor(request: DAPMessage, body: Record<string, unknown>): DAPMessage {
	return {
		type: 'response',
		seq: 1000 + (request.seq ?? 0),
		request_seq: request.seq,
		command: request.command,
		success: true,
		body,
	};
}

describe('DAPClient transport epochs', () => {
	test('replacement rejects only old requests and suppresses old responses and events', async () => {
		const oldTransport = new ControlledTransport();
		const newTransport = new ControlledTransport();
		const client = new ObservableDAPClient(oldTransport);

		const oldRequest = requestOutcome(client.request({ type: 'request', seq: 0, command: 'old' }));
		expect(oldTransport.sent).toHaveLength(1);

		client.bindTransport(newTransport);
		await expect(settleSoon(oldRequest)).resolves.toMatchObject({ status: 'rejected' });

		const newRequest = requestOutcome(client.request({ type: 'request', seq: 0, command: 'new' }));
		expect(newTransport.sent).toHaveLength(1);

		await oldTransport.receive(responseFor(oldTransport.sent[0], { source: 'old' }));
		await oldTransport.receive({ type: 'event', seq: 50, event: 'old-event' });
		expect(client.events).toEqual([]);
		await expect(settleSoon(newRequest)).resolves.toEqual({ status: 'pending' });

		await newTransport.receive(responseFor(newTransport.sent[0], { source: 'new' }));
		await expect(newRequest).resolves.toMatchObject({
			status: 'resolved',
			value: { body: { source: 'new' } },
		});
	});

	test('a late old disconnect cannot reject a new request or publish disconnection', async () => {
		const oldTransport = new ControlledTransport();
		const newTransport = new ControlledTransport();
		const client = new ObservableDAPClient(oldTransport);
		client.bindTransport(newTransport);

		const request = requestOutcome(client.request({ type: 'request', seq: 0, command: 'new' }));
		await oldTransport.disconnected('old transport lost');

		expect(client.disconnections).toEqual([]);
		await expect(settleSoon(request)).resolves.toEqual({ status: 'pending' });

		await newTransport.receive(responseFor(newTransport.sent[0], { ok: true }));
		await expect(request).resolves.toMatchObject({ status: 'resolved' });
	});

	test('late connected callbacks from a replaced transport are ignored', async () => {
		const oldTransport = new ControlledTransport();
		const newTransport = new ControlledTransport();
		const client = new ObservableDAPClient(oldTransport);
		client.bindTransport(newTransport);

		await oldTransport.connected('old');
		await newTransport.connected('new');

		expect(client.connections).toEqual(['new']);
	});

	test('a request sends through the transport and epoch captured at registration', async () => {
		const oldTransport = new ControlledTransport();
		const newTransport = new ControlledTransport();
		const client = new ObservableDAPClient(oldTransport);

		const request = requestOutcome(client.request({ type: 'request', seq: 0, command: 'captured' }));
		client.bindTransport(newTransport);

		expect(oldTransport.sent).toHaveLength(1);
		expect(newTransport.sent).toHaveLength(0);
		await expect(settleSoon(request)).resolves.toMatchObject({ status: 'rejected' });
	});

	test('an unknown response cannot write credential-bearing bodies to debug logs', async () => {
		const transport = new ControlledTransport();
		const messages: string[] = [];
		new ObservableDAPClient(transport, (message) => messages.push(message));

		await transport.receive({
			type: 'response',
			seq: 99,
			request_seq: 12345,
			command: 'auth',
			success: true,
			body: { userToken: 'rr_do-not-log' },
		});

		expect(messages.join('\n')).not.toContain('rr_do-not-log');
		expect(messages.join('\n')).toContain('12345');
	});

	test('received protocol traces are lazy, redact circular credentials, and preserve binary payload delivery', async () => {
		const noTraceTransport = new ControlledTransport();
		const circular = {} as Record<string, unknown>;
		circular.self = circular;
		let deliveredWithoutTrace: DAPMessage | undefined;
		noTraceTransport.bind({
			onReceive: async (message) => { deliveredWithoutTrace = message; },
		});
		const noTraceMessage: DAPMessage = {
			type: 'event',
			seq: 1,
			event: 'circular',
			arguments: circular,
		};
		await noTraceTransport.receive(noTraceMessage);
		expect(deliveredWithoutTrace).toBe(noTraceMessage);

		const traceTransport = new ControlledTransport();
		const traces: string[] = [];
		let deliveredWithTrace: DAPMessage | undefined;
		traceTransport.bind({
			onDebugProtocol: (message) => traces.push(message),
			onReceive: async (message) => { deliveredWithTrace = message; },
		});
		const binary = new Uint8Array([1, 2, 3]);
		const tracedCircular = {} as Record<string, unknown>;
		tracedCircular.self = tracedCircular;
		const traceMessage: DAPMessage = {
			type: 'event',
			seq: 2,
			event: 'binary',
			arguments: { data: binary, userToken: 'rr_do-not-log', tracedCircular },
		};
		await traceTransport.receive(traceMessage);

		expect(traces).toEqual(['RECV: {"type":"event","seq":2,"event":"binary","arguments":{"data":"<3 bytes>","userToken":"<redacted>","tracedCircular":{"self":"<circular>"}}}']);
		expect(deliveredWithTrace).toBe(traceMessage);
		expect(deliveredWithTrace?.arguments?.data).toBe(binary);
	});
});
