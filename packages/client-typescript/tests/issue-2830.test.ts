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

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { RocketRideClient } from '../src/client/client.js';
import {
	ConnectionException,
	RocketRideException,
	DAPException,
} from '../src/client/exceptions/index.js';
import { getEchoPipeline } from './echo.pipeline.js';

describe('Issue #2830 — ConnectionException typing and preservation', () => {
	it('should throw ConnectionException when connect() fails against an unreachable endpoint', async () => {
		const client = new RocketRideClient({
			uri: 'http://127.0.0.1:9',
			auth: 'TEST_KEY',
		});

		let caughtError: unknown;
		try {
			await client.connect();
		} catch (error) {
			caughtError = error;
		}

		expect(caughtError).toBeDefined();
		expect(caughtError instanceof ConnectionException).toBe(true);
		expect(caughtError instanceof RocketRideException).toBe(true);
		expect(caughtError instanceof DAPException).toBe(true);
		expect(caughtError instanceof Error).toBe(true);

		const connEx = caughtError as ConnectionException;
		expect(connEx.name).toBe('ConnectionException');
		expect(connEx.message).toContain('Failed to connect');
		// Original cause is preserved
		expect((connEx as unknown as { cause: unknown }).cause).toBeDefined();
	});

	it('should throw ConnectionException when attach() fails against an unreachable endpoint', async () => {
		const client = new RocketRideClient({
			uri: 'http://127.0.0.1:9',
		});

		let caughtError: unknown;
		try {
			await client.attach();
		} catch (error) {
			caughtError = error;
		}

		expect(caughtError).toBeDefined();
		expect(caughtError instanceof ConnectionException).toBe(true);
	});
});

describe('Issue #2830 — Persist mode retry and onConnectError callback lifecycle', () => {
	class MockWebSocket {
		static instances: MockWebSocket[] = [];
		readonly url: string;
		onopen: ((event: unknown) => unknown) | null = null;
		onmessage: ((event: unknown) => unknown) | null = null;
		onclose: ((event: unknown) => unknown) | null = null;
		onerror: ((event: unknown) => unknown) | null = null;
		readyState = 0;

		constructor(url: string) {
			this.url = url;
			MockWebSocket.instances.push(this);
		}

		error(): void {
			this.onerror?.({});
		}

		open(): void {
			this.readyState = 1;
			this.onopen?.({});
		}

		close(code = 1000, reason = ''): void {
			this.readyState = 3;
			this.onclose?.({ code, reason, wasClean: code === 1000 });
		}
	}

	let originalWindow: PropertyDescriptor | undefined;
	let originalWebSocket: PropertyDescriptor | undefined;

	beforeEach(() => {
		originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: { WebSocket: MockWebSocket },
		});
		Object.defineProperty(globalThis, 'WebSocket', {
			configurable: true,
			value: MockWebSocket,
		});
		MockWebSocket.instances = [];
	});

	afterEach(() => {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else Reflect.deleteProperty(globalThis, 'window');
		if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
		else Reflect.deleteProperty(globalThis, 'WebSocket');
		jest.useRealTimers();
	});

	async function flushMicrotasks(turns = 10): Promise<void> {
		for (let i = 0; i < turns; i++) await Promise.resolve();
	}

	it('should call onConnectError on the first connection failure in persist mode and schedule retries', async () => {
		jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });

		const onConnectError = jest.fn(async (_error: ConnectionException) => undefined);
		const client = new RocketRideClient({
			persist: true,
			uri: 'ws://mock-server:1234',
			auth: 'TEST_KEY',
			onConnectError,
		});

		// Start foreground connect()
		const connectPromise = client.connect();
		await flushMicrotasks();

		// Trigger connection failure on the initial socket
		expect(MockWebSocket.instances).toHaveLength(1);
		const initialSocket = MockWebSocket.instances[0];
		initialSocket.error();
		await flushMicrotasks();

		// Foreground connect() must reject with ConnectionException
		await expect(connectPromise).rejects.toThrow(ConnectionException);

		// onConnectError MUST be called on the initial failure
		expect(onConnectError).toHaveBeenCalledTimes(1);
		const firstError = onConnectError.mock.calls[0][0];
		expect(firstError instanceof ConnectionException).toBe(true);

		// A retry must be scheduled; verify backoff
		const internals = client as unknown as {
			_currentReconnectDelay: number;
			_reconnectTimer?: ReturnType<typeof setTimeout>;
		};
		expect(internals._reconnectTimer).toBeDefined();

		// Advance timer to trigger the first background retry (delay = 500ms after first backoff advance)
		jest.advanceTimersByTime(500);
		await flushMicrotasks();

		// A second connection attempt must have been spawned
		expect(MockWebSocket.instances).toHaveLength(2);
		const secondSocket = MockWebSocket.instances[1];
		secondSocket.error();
		await flushMicrotasks();

		// onConnectError MUST be called again for the retry failure
		expect(onConnectError).toHaveBeenCalledTimes(2);

		// Calling disconnect() cancels reconnect timers and halts retries
		await client.disconnect();
		expect(internals._reconnectTimer).toBeUndefined();

		// Advancing time further produces no more connection attempts
		jest.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(onConnectError).toHaveBeenCalledTimes(2);
	});
});

describe('Issue #2830 — File-store path validation and traversal prevention', () => {
	let client: RocketRideClient;

	beforeEach(() => {
		client = new RocketRideClient({
			uri: 'http://127.0.0.1:9',
			auth: 'TEST_KEY',
		});
	});

	it('should reject absolute paths starting with / in all file-store methods', async () => {
		const absPath = '/etc/passwd';
		await expect(client.fsOpen(absPath, 'r')).rejects.toThrow('Path must be relative');
		await expect(client.fsStat(absPath)).rejects.toThrow('Path must be relative');
		await expect(client.fsDelete(absPath)).rejects.toThrow('Path must be relative');
		await expect(client.fsMkdir(absPath)).rejects.toThrow('Path must be relative');
		await expect(client.fsRename(absPath, 'valid/dest.txt')).rejects.toThrow('Path must be relative');
		await expect(client.fsRename('valid/src.txt', absPath)).rejects.toThrow('Path must be relative');
		await expect(client.fsGetUrl(absPath)).rejects.toThrow('Path must be relative');
		await expect(client.fsReadMany([absPath])).rejects.toThrow('Path must be relative');
	});

	it('should reject absolute paths starting with \\ in file-store methods', async () => {
		const winAbsPath = '\\windows\\system32';
		await expect(client.fsOpen(winAbsPath, 'r')).rejects.toThrow('Path must be relative');
		await expect(client.fsStat(winAbsPath)).rejects.toThrow('Path must be relative');
	});

	it('should reject path traversal attempts (..) in all positions', async () => {
		await expect(client.fsOpen('..', 'r')).rejects.toThrow('Path traversal not allowed');
		await expect(client.fsOpen('../escaped.txt', 'r')).rejects.toThrow('Path traversal not allowed');
		await expect(client.fsOpen('subdir/../../secret.txt', 'r')).rejects.toThrow('Path traversal not allowed');
		await expect(client.fsOpen('subdir/..', 'r')).rejects.toThrow('Path traversal not allowed');
	});

	it('should reject illegal characters in file-store paths', async () => {
		await expect(client.fsOpen('folder/file<name>.txt', 'r')).rejects.toThrow('Path contains invalid characters');
		await expect(client.fsOpen('folder/file>name.txt', 'r')).rejects.toThrow('Path contains invalid characters');
		await expect(client.fsOpen('folder/file"name.txt', 'r')).rejects.toThrow('Path contains invalid characters');
		await expect(client.fsOpen('folder/file|name.txt', 'r')).rejects.toThrow('Path contains invalid characters');
		await expect(client.fsOpen('folder/file?name.txt', 'r')).rejects.toThrow('Path contains invalid characters');
		await expect(client.fsOpen('folder/file*name.txt', 'r')).rejects.toThrow('Path contains invalid characters');
	});

	it('should allow valid relative store paths without throwing validation errors', async () => {
		const validPaths = [
			'data.json',
			'subfolder/data.json',
			'.templates/my-pipe.json',
			'deeply/nested/path/to/resource.txt',
		];

		// validateStorePath should pass for these; calling a method against dead server
		// will fail on network/auth, NOT on path validation
		for (const p of validPaths) {
			const promise = client.fsStat(p);
			await expect(promise).rejects.not.toThrow('Path must be relative');
			await expect(promise).rejects.not.toThrow('Path traversal not allowed');
			await expect(promise).rejects.not.toThrow('Path contains invalid characters');
		}
	});
});

describe('Issue #2830 — sendFiles([]) and use() unwrapping', () => {
	let client: RocketRideClient;

	beforeEach(() => {
		client = new RocketRideClient({
			uri: 'http://127.0.0.1:9',
			auth: 'TEST_KEY',
		});
	});

	it('should return empty array when sendFiles is called with empty array []', async () => {
		const result = await client.sendFiles([], 'any-token');
		expect(result).toEqual([]);
	});

	it('should unwrap {"pipeline": {...}} object when passed to client.use({ pipeline })', async () => {
		const flatPipeline = getEchoPipeline('unwrap-test');
		const wrappedPipeline = { pipeline: flatPipeline };

		let sentPipelineArg: unknown;
		jest.spyOn(client, 'call').mockImplementation(async (command: string, args: unknown) => {
			if (command === 'execute') {
				sentPipelineArg = (args as Record<string, unknown>).pipeline;
				return { token: 'UNWRAPPED_TASK_TOKEN' };
			}
			return {};
		});

		const result = await client.use({
			pipeline: wrappedPipeline,
		});

		expect(result.token).toBe('UNWRAPPED_TASK_TOKEN');
		expect(sentPipelineArg).toBeDefined();
		// Must not have double wrapped { pipeline: { pipeline: ... } }
		expect((sentPipelineArg as Record<string, unknown>).pipeline).toBeUndefined();
		expect((sentPipelineArg as Record<string, unknown>).source).toBe('webhook_1');
	});

	it('should preserve fallback error as cause in _operationTerminalError when unexpectedDisconnectError has no cause', () => {
		const clientInstance = new RocketRideClient({ uri: 'ws://127.0.0.1:5565' });
		const unexpectedError = new ConnectionException({ message: 'Connection lost' });
		const operation = {
			unexpectedDisconnectError: unexpectedError,
		};
		const fallback = new Error('WebSocket closed abnormal closure 1006');
		const result = (clientInstance as unknown as { _operationTerminalError: (op: unknown, fb?: unknown) => unknown })._operationTerminalError(operation, fallback);

		expect(result).toBe(unexpectedError);
		expect(unexpectedError.cause).toBe(fallback);
	});

	it('should not overwrite an existing cause on unexpectedDisconnectError in _operationTerminalError', () => {
		const clientInstance = new RocketRideClient({ uri: 'ws://127.0.0.1:5565' });
		const originalCause = new Error('Original cause');
		const unexpectedError = new ConnectionException({ message: 'Connection lost', cause: originalCause });
		const operation = {
			unexpectedDisconnectError: unexpectedError,
		};
		const fallback = new Error('Later fallback');
		const result = (clientInstance as unknown as { _operationTerminalError: (op: unknown, fb?: unknown) => unknown })._operationTerminalError(operation, fallback);

		expect(result).toBe(unexpectedError);
		expect(unexpectedError.cause).toBe(originalCause);
	});
});
