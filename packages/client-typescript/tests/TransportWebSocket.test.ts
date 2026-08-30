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

import { EventEmitter } from 'node:events';
import { TransportWebSocket } from '../src/client/core/TransportWebSocket';
import type { DAPMessage } from '../src/client/types';

type BrowserHandler<T> = ((event: T) => unknown) | null;

class FakeNodeWebSocket extends EventEmitter {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeNodeWebSocket[] = [];

	readonly url: string;
	readyState = FakeNodeWebSocket.CONNECTING;
	sent: unknown[] = [];

	constructor(url: string) {
		super();
		this.url = url;
		FakeNodeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = FakeNodeWebSocket.OPEN;
		this.emit('open');
	}

	message(message: DAPMessage): void {
		this.emit('message', Buffer.from(JSON.stringify(message)), false);
	}

	emitClose(code = 1000, reason = ''): void {
		this.readyState = FakeNodeWebSocket.CLOSED;
		this.emit('close', code, Buffer.from(reason));
	}

	close(code = 1000, reason = ''): void {
		this.readyState = FakeNodeWebSocket.CLOSING;
		queueMicrotask(() => this.emitClose(code, reason));
	}

	terminate(): void {
		this.emitClose(1006, 'terminated');
	}

	ping(): void {}

	send(data: unknown): void {
		this.sent.push(data);
	}
}

jest.mock('ws', () => ({
	__esModule: true,
	default: FakeNodeWebSocket,
	WebSocket: FakeNodeWebSocket,
}));

class FakeBrowserWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeBrowserWebSocket[] = [];

	readonly url: string;
	readyState = FakeBrowserWebSocket.CONNECTING;
	binaryType = '';
	onopen: BrowserHandler<Event> = null;
	onmessage: BrowserHandler<MessageEvent> = null;
	onclose: BrowserHandler<CloseEvent> = null;
	onerror: BrowserHandler<Event> = null;
	sent: unknown[] = [];

	constructor(url: string) {
		this.url = url;
		FakeBrowserWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = FakeBrowserWebSocket.OPEN;
		void this.onopen?.({} as Event);
	}

	message(data: string): void {
		void this.onmessage?.({ data } as MessageEvent);
	}

	error(): void {
		void this.onerror?.({} as Event);
	}

	emitClose(code = 1000, reason = ''): void {
		this.readyState = FakeBrowserWebSocket.CLOSED;
		void this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
	}

	close(code = 1000, reason = ''): void {
		this.readyState = FakeBrowserWebSocket.CLOSING;
		queueMicrotask(() => this.emitClose(code, reason));
	}

	send(data: unknown): void {
		this.sent.push(data);
	}
}

type TestSocket = FakeNodeWebSocket | FakeBrowserWebSocket;

interface CapturedSocketHandlers {
	open(): void;
	message(message: DAPMessage): void;
	error(error: Error): void;
	close(code?: number, reason?: string): void;
}

interface WebSocketHarness {
	uri(label: string): string;
	waitForAttempts(label: string, count?: number): Promise<void>;
	attemptCount(label: string): number;
	currentSocket(transport: TransportWebSocket): TestSocket;
	captureHandlers(socket: TestSocket): CapturedSocketHandlers;
	open(label: string, socket: TestSocket): Promise<void>;
	message(socket: TestSocket, message: DAPMessage): void;
	error(socket: TestSocket, error: Error): void;
	close(socket: TestSocket, code?: number, reason?: string): void;
	listenerCount(socket: TestSocket): number;
	cleanup(): Promise<void>;
}

class NodeHarness implements WebSocketHarness {
	async start(): Promise<void> {
		FakeNodeWebSocket.instances = [];
	}

	uri(label: string): string {
		return `ws://node.test/${label}`;
	}

	async waitForAttempts(label: string, count = 1): Promise<void> {
		for (let tries = 0; tries < 100; tries += 1) {
			if (this.attemptCount(label) >= count) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`Timed out waiting for ${count} ${label} WebSocket attempt(s)`);
	}

	attemptCount(label: string): number {
		return FakeNodeWebSocket.instances.filter(({ url }) => url === this.uri(label)).length;
	}

	currentSocket(transport: TransportWebSocket): FakeNodeWebSocket {
		const socket = (transport as unknown as { _websocket?: FakeNodeWebSocket })._websocket;
		if (!socket) throw new Error('Transport has no current Node WebSocket');
		return socket;
	}

	captureHandlers(socket: TestSocket): CapturedSocketHandlers {
		const nodeSocket = socket as FakeNodeWebSocket;
		const open = nodeSocket.listeners('open')[0] as (() => void) | undefined;
		const message = nodeSocket.listeners('message')[0] as ((data: Buffer, isBinary: boolean) => void) | undefined;
		const error = nodeSocket.listeners('error')[0] as ((error: Error) => void) | undefined;
		const close = nodeSocket.listeners('close')[0] as ((code: number, reason: Buffer) => void) | undefined;
		if (!open || !message || !error || !close) throw new Error('Node WebSocket handlers are not wired');
		return {
			open: () => open.call(nodeSocket),
			message: (packet) => message.call(nodeSocket, Buffer.from(JSON.stringify(packet)), false),
			error: (failure) => error.call(nodeSocket, failure),
			close: (code = 1000, reason = '') => close.call(nodeSocket, code, Buffer.from(reason)),
		};
	}

	async open(_label: string, socket: TestSocket): Promise<void> {
		(socket as FakeNodeWebSocket).open();
		await Promise.resolve();
	}

	message(socket: TestSocket, message: DAPMessage): void {
		(socket as FakeNodeWebSocket).message(message);
	}

	error(socket: TestSocket, error: Error): void {
		const nodeSocket = socket as FakeNodeWebSocket;
		if (nodeSocket.listenerCount('error') > 0) nodeSocket.emit('error', error);
	}

	close(socket: TestSocket, code = 1000, reason = ''): void {
		const nodeSocket = socket as FakeNodeWebSocket;
		if (nodeSocket.listenerCount('close') > 0) nodeSocket.emitClose(code, reason);
	}

	listenerCount(socket: TestSocket): number {
		return (socket as FakeNodeWebSocket).eventNames().reduce((total, eventName) => total + (socket as FakeNodeWebSocket).listenerCount(eventName), 0);
	}

	async cleanup(): Promise<void> {
		for (const socket of FakeNodeWebSocket.instances) socket.removeAllListeners();
		FakeNodeWebSocket.instances = [];
	}
}

class BrowserHarness implements WebSocketHarness {
	uri(label: string): string {
		return `ws://browser.test/${label}`;
	}

	async waitForAttempts(label: string, count = 1): Promise<void> {
		for (let tries = 0; tries < 100; tries += 1) {
			if (this.attemptCount(label) >= count) return;
			await Promise.resolve();
		}
		throw new Error(`Timed out waiting for ${count} ${label} WebSocket attempt(s)`);
	}

	attemptCount(label: string): number {
		return FakeBrowserWebSocket.instances.filter(({ url }) => url === this.uri(label)).length;
	}

	currentSocket(transport: TransportWebSocket): FakeBrowserWebSocket {
		const socket = (transport as unknown as { _websocket?: FakeBrowserWebSocket })._websocket;
		if (!socket) throw new Error('Transport has no current browser WebSocket');
		return socket;
	}

	captureHandlers(socket: TestSocket): CapturedSocketHandlers {
		const browserSocket = socket as FakeBrowserWebSocket;
		const open = browserSocket.onopen;
		const message = browserSocket.onmessage;
		const error = browserSocket.onerror;
		const close = browserSocket.onclose;
		if (!open || !message || !error || !close) throw new Error('Browser WebSocket handlers are not wired');
		return {
			open: () => open.call(browserSocket, {} as Event),
			message: (packet) => message.call(browserSocket, { data: JSON.stringify(packet) } as MessageEvent),
			error: () => error.call(browserSocket, {} as Event),
			close: (code = 1000, reason = '') => close.call(browserSocket, { code, reason, wasClean: code === 1000 } as CloseEvent),
		};
	}

	async open(_label: string, socket: TestSocket): Promise<void> {
		(socket as FakeBrowserWebSocket).open();
		await Promise.resolve();
	}

	message(socket: TestSocket, message: DAPMessage): void {
		(socket as FakeBrowserWebSocket).message(JSON.stringify(message));
	}

	error(socket: TestSocket): void {
		(socket as FakeBrowserWebSocket).error();
	}

	close(socket: TestSocket, code = 1000, reason = ''): void {
		(socket as FakeBrowserWebSocket).emitClose(code, reason);
	}

	listenerCount(socket: TestSocket): number {
		const browserSocket = socket as FakeBrowserWebSocket;
		return [browserSocket.onopen, browserSocket.onmessage, browserSocket.onerror, browserSocket.onclose].filter(Boolean).length;
	}

	async cleanup(): Promise<void> {
		FakeBrowserWebSocket.instances = [];
	}
}

function outcome<T>(promise: Promise<T>): Promise<{ status: 'resolved'; value: T } | { status: 'rejected'; error: unknown }> {
	return promise.then(
		(value) => ({ status: 'resolved' as const, value }),
		(error) => ({ status: 'rejected' as const, error })
	);
}

async function settleSoon<T>(promise: Promise<{ status: 'resolved'; value: T } | { status: 'rejected'; error: unknown }>): Promise<{ status: 'resolved'; value: T } | { status: 'rejected'; error: unknown } | { status: 'pending' }> {
	return Promise.race([promise, new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50))]);
}

describe.each(['node ws', 'browser WebSocket'] as const)('TransportWebSocket lifecycle on %s', (runtime) => {
	let harness: WebSocketHarness;
	let originalWindow: PropertyDescriptor | undefined;
	let originalWebSocket: PropertyDescriptor | undefined;

	beforeEach(async () => {
		originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
		FakeBrowserWebSocket.instances = [];

		if (runtime === 'browser WebSocket') {
			Object.defineProperty(globalThis, 'window', {
				configurable: true,
				value: { WebSocket: FakeBrowserWebSocket },
			});
			Object.defineProperty(globalThis, 'WebSocket', {
				configurable: true,
				value: FakeBrowserWebSocket,
			});
			harness = new BrowserHarness();
		} else {
			Reflect.deleteProperty(globalThis, 'window');
			const nodeHarness = new NodeHarness();
			await nodeHarness.start();
			harness = nodeHarness;
		}
	});

	afterEach(async () => {
		await harness.cleanup();
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else Reflect.deleteProperty(globalThis, 'window');
		if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
		else Reflect.deleteProperty(globalThis, 'WebSocket');
	});

	test('disconnect cancels a CONNECTING attempt without publishing disconnected', async () => {
		const disconnected = jest.fn();
		const transport = new TransportWebSocket(harness.uri('pending'));
		transport.bind({ onDisconnected: disconnected });

		const connectOutcome = outcome(transport.connect(250));
		await harness.waitForAttempts('pending');
		await transport.disconnect();

		await expect(settleSoon(connectOutcome)).resolves.toMatchObject({ status: 'rejected' });
		expect(disconnected).not.toHaveBeenCalled();
		expect(transport.isConnected()).toBe(false);
	});

	test('same-URI concurrent connects share one socket attempt and outcome', async () => {
		const transport = new TransportWebSocket(harness.uri('same'));

		const first = transport.connect(250);
		const second = transport.connect(250);
		await harness.waitForAttempts('same');
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		expect(harness.attemptCount('same')).toBe(1);
		await harness.open('same', harness.currentSocket(transport));
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		await transport.disconnect();
	});

	test('A to B replacement rejects A and establishes only B', async () => {
		const disconnected = jest.fn();
		const transport = new TransportWebSocket(harness.uri('a'));
		transport.bind({ onDisconnected: disconnected });

		const first = outcome(transport.connect(250));
		await harness.waitForAttempts('a');
		transport.setUri(harness.uri('b'));
		const second = transport.connect(250);

		await expect(settleSoon(first)).resolves.toMatchObject({ status: 'rejected' });
		await harness.waitForAttempts('b');
		await harness.open('b', harness.currentSocket(transport));
		await expect(second).resolves.toBeUndefined();
		expect(transport.getConnectionInfo()).toBe(harness.uri('b'));
		expect(disconnected).not.toHaveBeenCalled();
		await transport.disconnect();
	});

	test('late events from replaced A cannot mutate or publish against B', async () => {
		const disconnected = jest.fn();
		const received = jest.fn(async () => undefined);
		const transport = new TransportWebSocket(harness.uri('a'));
		transport.bind({ onDisconnected: disconnected, onReceive: received });

		const first = outcome(transport.connect(250));
		await harness.waitForAttempts('a');
		const oldSocket = harness.currentSocket(transport);
		const oldHandlers = harness.captureHandlers(oldSocket);

		transport.setUri(harness.uri('b'));
		const second = transport.connect(250);
		await harness.waitForAttempts('b');
		await harness.open('b', harness.currentSocket(transport));
		await second;
		await expect(settleSoon(first)).resolves.toMatchObject({ status: 'rejected' });

		oldHandlers.open();
		oldHandlers.message({ type: 'event', seq: 1, event: 'old' });
		oldHandlers.error(new Error('late A error'));
		oldHandlers.close(1006, 'late A close');
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		expect(transport.isConnected()).toBe(true);
		expect(received).not.toHaveBeenCalled();
		expect(disconnected).not.toHaveBeenCalled();
		expect(harness.listenerCount(oldSocket)).toBe(0);
		await transport.disconnect();
	});

	test('setUri immediately invalidates an established socket before the replacement connects', async () => {
		const disconnected = jest.fn(async () => undefined);
		const received = jest.fn(async () => undefined);
		const transport = new TransportWebSocket(harness.uri('established-a'));
		transport.bind({ onDisconnected: disconnected, onReceive: received });

		const first = transport.connect(250);
		await harness.waitForAttempts('established-a');
		const oldSocket = harness.currentSocket(transport);
		await harness.open('established-a', oldSocket);
		await first;
		const oldHandlers = harness.captureHandlers(oldSocket);

		transport.setUri(harness.uri('established-b'));
		expect(transport.isConnected()).toBe(false);
		expect(transport.getConnectionInfo()).toBe(harness.uri('established-b'));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(harness.listenerCount(oldSocket)).toBe(0);

		oldHandlers.message({ type: 'event', seq: 1, event: 'stale-established-a' });
		oldHandlers.error(new Error('stale established A error'));
		oldHandlers.close(1006, 'stale established A close');

		const second = transport.connect(250);
		await harness.waitForAttempts('established-b');
		await harness.open('established-b', harness.currentSocket(transport));
		await second;
		expect(received).not.toHaveBeenCalled();
		expect(disconnected).not.toHaveBeenCalled();
		await transport.disconnect();
	});

	test('an established error followed by close publishes disconnected once', async () => {
		const disconnected = jest.fn(async () => undefined);
		const transport = new TransportWebSocket(harness.uri('error-close'));
		transport.bind({ onDisconnected: disconnected });

		const connected = transport.connect(250);
		await harness.waitForAttempts('error-close');
		const socket = harness.currentSocket(transport);
		await harness.open('error-close', socket);
		await connected;

		harness.error(socket, new Error('boom'));
		harness.close(socket, 1006, 'lost');
		await new Promise<void>((resolve) => setTimeout(resolve, 30));

		expect(disconnected).toHaveBeenCalledTimes(1);
		expect(transport.isConnected()).toBe(false);
	});

	test('disconnect is idempotent and clears every socket resource', async () => {
		const disconnected = jest.fn(async () => undefined);
		const transport = new TransportWebSocket(harness.uri('cleanup'));
		transport.bind({ onDisconnected: disconnected });

		const connected = transport.connect(250);
		await harness.waitForAttempts('cleanup');
		const socket = harness.currentSocket(transport);
		await harness.open('cleanup', socket);
		await connected;

		await transport.disconnect();
		await transport.disconnect();

		const internals = transport as unknown as {
			_websocket?: TestSocket | null;
			_connectionTimeout?: ReturnType<typeof setTimeout>;
			_pingInterval?: ReturnType<typeof setInterval>;
			_messageTasks: Set<Promise<void>>;
		};
		expect(transport.isConnected()).toBe(false);
		expect(internals._websocket).toBeUndefined();
		expect(internals._connectionTimeout).toBeUndefined();
		expect(internals._pingInterval).toBeUndefined();
		expect(internals._messageTasks.size).toBe(0);
		expect(harness.listenerCount(socket)).toBe(0);
		expect(disconnected).toHaveBeenCalledTimes(1);
	});

	test('sent protocol traces are lazy and redact only when a debug callback is bound', async () => {
		const transport = new TransportWebSocket(harness.uri('send-trace'));
		const traces: string[] = [];
		transport.bind({});

		const connected = transport.connect(250);
		await harness.waitForAttempts('send-trace');
		const socket = harness.currentSocket(transport);
		await harness.open('send-trace', socket);
		await connected;

		const redactSpy = jest.spyOn(transport as unknown as { _redactProtocolMessage: (value: unknown) => unknown }, '_redactProtocolMessage');

		// Untraced: neither the JSON nor the binary branch may pay for a redaction walk.
		await transport.send({ type: 'request', seq: 1, command: 'noTrace' });
		await transport.send({
			type: 'request',
			seq: 2,
			command: 'noTraceBinary',
			arguments: { data: new Uint8Array([1, 2, 3]), userToken: 'rr_do-not-log' },
		});
		expect(redactSpy).not.toHaveBeenCalled();

		// Traced: both branches redact, and the binary payload is summarized, not logged.
		transport.bind({ onDebugProtocol: (message) => traces.push(message) });
		await transport.send({ type: 'request', seq: 3, command: 'traced', arguments: { userToken: 'rr_do-not-log' } });
		await transport.send({
			type: 'request',
			seq: 4,
			command: 'tracedBinary',
			arguments: { data: new Uint8Array([1, 2, 3]), userToken: 'rr_do-not-log' },
		});

		expect(redactSpy).toHaveBeenCalledTimes(2);
		expect(traces).toEqual(['SEND: {"type":"request","seq":3,"command":"traced","arguments":{"userToken":"<redacted>"}}', 'SEND: {"type":"request","seq":4,"command":"tracedBinary","arguments":{"data":"<3 bytes>","userToken":"<redacted>"}}']);

		redactSpy.mockRestore();
		await transport.disconnect();
	});

	test('a synchronous socket close clears its fallback timer before disconnect resolves', async () => {
		const transport = new TransportWebSocket(harness.uri('synchronous-close'));
		const connected = transport.connect(250);
		await harness.waitForAttempts('synchronous-close');
		const socket = harness.currentSocket(transport);
		await harness.open('synchronous-close', socket);
		await connected;

		if (runtime === 'browser WebSocket') {
			const browserSocket = socket as FakeBrowserWebSocket;
			browserSocket.close = (code = 1000, reason = '') => {
				browserSocket.emitClose(code, reason);
			};
		} else {
			const nodeSocket = socket as FakeNodeWebSocket;
			nodeSocket.close = (code = 1000, reason = '') => {
				nodeSocket.emitClose(code, reason);
			};
		}

		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const fallbackTimers = new Set<ReturnType<typeof setTimeout>>();
		globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
			const timer = realSetTimeout(() => {
				fallbackTimers.delete(timer);
				callback(...args);
			}, delay);
			fallbackTimers.add(timer);
			return timer;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
			fallbackTimers.delete(timer);
			realClearTimeout(timer);
		}) as typeof clearTimeout;

		try {
			await transport.disconnect();
			expect(fallbackTimers.size).toBe(0);
		} finally {
			for (const timer of fallbackTimers) realClearTimeout(timer);
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		}
	});

	test.each(['error', 'close'] as const)('a pre-open %s rejects the attempt and clears socket resources without disconnected publication', async (failure) => {
		const disconnected = jest.fn(async () => undefined);
		const transport = new TransportWebSocket(harness.uri(`pre-open-${failure}`));
		transport.bind({ onDisconnected: disconnected });

		const connected = outcome(transport.connect(250));
		await harness.waitForAttempts(`pre-open-${failure}`);
		const socket = harness.currentSocket(transport);
		if (failure === 'error') harness.error(socket, new Error('pre-open failure'));
		else harness.close(socket, 1006, 'pre-open close');

		await expect(connected).resolves.toMatchObject({ status: 'rejected' });
		await transport.disconnect();
		const internals = transport as unknown as {
			_connectionTimeout?: ReturnType<typeof setTimeout>;
			_pingInterval?: ReturnType<typeof setInterval>;
			_messageTasks: Set<Promise<void>>;
		};
		expect(transport.isConnected()).toBe(false);
		expect(internals._connectionTimeout).toBeUndefined();
		expect(internals._pingInterval).toBeUndefined();
		expect(internals._messageTasks.size).toBe(0);
		expect(harness.listenerCount(socket)).toBe(0);
		expect(disconnected).not.toHaveBeenCalled();
	});

	test('a pre-open timeout rejects the attempt and clears socket resources', async () => {
		const transport = new TransportWebSocket(harness.uri('pre-open-timeout'));
		const connected = outcome(transport.connect(10));
		await harness.waitForAttempts('pre-open-timeout');
		const socket = harness.currentSocket(transport);

		await expect(connected).resolves.toMatchObject({
			status: 'rejected',
			error: { message: 'Connection timeout after 10ms' },
		});
		await transport.disconnect();
		expect(transport.isConnected()).toBe(false);
		expect(harness.listenerCount(socket)).toBe(0);
	});

	test('a rejecting disconnected callback is logged while event-driven cleanup remains idempotent', async () => {
		const debugMessages: string[] = [];
		const transport = new TransportWebSocket(harness.uri('rejecting-disconnected'));
		transport.bind({
			onDebugMessage: (message) => debugMessages.push(message),
			onDisconnected: async () => {
				throw new Error('disconnected callback failed');
			},
		});

		const connected = transport.connect(250);
		await harness.waitForAttempts('rejecting-disconnected');
		const socket = harness.currentSocket(transport);
		await harness.open('rejecting-disconnected', socket);
		await connected;

		harness.close(socket, 1006, 'event-driven close');
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		await expect(transport.disconnect()).resolves.toBeUndefined();
		expect(debugMessages.join('\n')).toContain('disconnected callback failed');
		const internals = transport as unknown as {
			_connectionTimeout?: ReturnType<typeof setTimeout>;
			_pingInterval?: ReturnType<typeof setInterval>;
			_messageTasks: Set<Promise<void>>;
			_cleanupOperations: Set<Promise<void>>;
		};
		expect(transport.isConnected()).toBe(false);
		expect(internals._connectionTimeout).toBeUndefined();
		expect(internals._pingInterval).toBeUndefined();
		expect(internals._messageTasks.size).toBe(0);
		expect(internals._cleanupOperations.size).toBe(0);
		expect(harness.listenerCount(socket)).toBe(0);
		expect(socket.readyState).toBe(runtime === 'browser WebSocket' ? FakeBrowserWebSocket.CLOSED : FakeNodeWebSocket.CLOSED);
	});

	test('a receive callback can immediately await disconnect without deadlocking its own task', async () => {
		let resolveCallback!: () => void;
		let rejectCallback!: (error: unknown) => void;
		const callbackSettled = new Promise<void>((resolve, reject) => {
			resolveCallback = resolve;
			rejectCallback = reject;
		});
		const transport = new TransportWebSocket(harness.uri('reentrant-disconnect'));
		transport.bind({
			onReceive: async () => {
				try {
					await transport.disconnect();
					resolveCallback();
				} catch (error) {
					rejectCallback(error);
				}
			},
		});

		const connected = transport.connect(250);
		await harness.waitForAttempts('reentrant-disconnect');
		const socket = harness.currentSocket(transport);
		await harness.open('reentrant-disconnect', socket);
		await connected;
		harness.message(socket, { type: 'event', seq: 1, event: 'disconnect-now' });

		await expect(settleSoon(outcome(callbackSettled))).resolves.toMatchObject({ status: 'resolved' });
		const internals = transport as unknown as {
			_connectionTimeout?: ReturnType<typeof setTimeout>;
			_pingInterval?: ReturnType<typeof setInterval>;
			_messageTasks: Set<Promise<void>>;
			_cleanupOperations: Set<Promise<void>>;
		};
		expect(transport.isConnected()).toBe(false);
		expect(internals._connectionTimeout).toBeUndefined();
		expect(internals._pingInterval).toBeUndefined();
		expect(internals._messageTasks.size).toBe(0);
		expect(internals._cleanupOperations.size).toBe(0);
		expect(harness.listenerCount(socket)).toBe(0);
	});

	test('a receive callback can await before disconnecting without deadlocking its own task', async () => {
		let resolveCallback!: () => void;
		let rejectCallback!: (error: unknown) => void;
		const callbackSettled = new Promise<void>((resolve, reject) => {
			resolveCallback = resolve;
			rejectCallback = reject;
		});
		const transport = new TransportWebSocket(harness.uri('delayed-reentrant-disconnect'));
		transport.bind({
			onReceive: async () => {
				try {
					await Promise.resolve();
					await transport.disconnect();
					resolveCallback();
				} catch (error) {
					rejectCallback(error);
				}
			},
		});

		const connected = transport.connect(250);
		await harness.waitForAttempts('delayed-reentrant-disconnect');
		const socket = harness.currentSocket(transport);
		await harness.open('delayed-reentrant-disconnect', socket);
		await connected;
		harness.message(socket, { type: 'event', seq: 1, event: 'disconnect-after-await' });

		await expect(settleSoon(outcome(callbackSettled))).resolves.toMatchObject({ status: 'resolved' });
		const internals = transport as unknown as {
			_connectionTimeout?: ReturnType<typeof setTimeout>;
			_pingInterval?: ReturnType<typeof setInterval>;
			_messageTasks: Set<Promise<void>>;
			_cleanupOperations: Set<Promise<void>>;
		};
		expect(transport.isConnected()).toBe(false);
		expect(internals._connectionTimeout).toBeUndefined();
		expect(internals._pingInterval).toBeUndefined();
		expect(internals._messageTasks.size).toBe(0);
		expect(internals._cleanupOperations.size).toBe(0);
		expect(harness.listenerCount(socket)).toBe(0);
	});

	test('disconnect waits for message tasks owned by every replaced epoch', async () => {
		let releaseMessage!: () => void;
		const messageGate = new Promise<void>((resolve) => {
			releaseMessage = resolve;
		});
		const received = jest.fn(async () => messageGate);
		const transport = new TransportWebSocket(harness.uri('draining-a'));
		transport.bind({ onReceive: received });

		const first = transport.connect(250);
		await harness.waitForAttempts('draining-a');
		const oldSocket = harness.currentSocket(transport);
		await harness.open('draining-a', oldSocket);
		await first;
		harness.message(oldSocket, { type: 'event', seq: 1, event: 'held' });
		for (let attempt = 0; attempt < 100 && received.mock.calls.length === 0; attempt += 1) {
			await Promise.resolve();
		}
		expect(received).toHaveBeenCalledTimes(1);

		transport.setUri(harness.uri('draining-b'));
		const second = transport.connect(250);
		await harness.waitForAttempts('draining-b');
		const newSocket = harness.currentSocket(transport);
		await harness.open('draining-b', newSocket);
		await second;

		const disconnected = outcome(transport.disconnect());
		await expect(settleSoon(disconnected)).resolves.toEqual({ status: 'pending' });
		releaseMessage();
		await expect(disconnected).resolves.toMatchObject({ status: 'resolved' });
		expect(harness.listenerCount(oldSocket)).toBe(0);
		expect(harness.listenerCount(newSocket)).toBe(0);
	});
});
