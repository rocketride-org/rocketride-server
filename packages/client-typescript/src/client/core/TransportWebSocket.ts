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

import { TransportBase } from './TransportBase.js';
import { DAPMessage } from '../types/index.js';
import { CONST_DEFAULT_SERVICE, CONST_SOCKET_TIMEOUT, CONST_WS_PING_INTERVAL, CONST_WS_PING_TIMEOUT } from '../constants.js';

let NodeWebSocket: typeof import('ws') | undefined;
let NodeWebSocketPromise: Promise<typeof import('ws') | undefined> | null = null;

async function ensureNodeWebSocket(): Promise<typeof import('ws') | undefined> {
	if (NodeWebSocket !== undefined) return NodeWebSocket;
	if (typeof window !== 'undefined') return undefined;
	if (NodeWebSocketPromise) return NodeWebSocketPromise;
	NodeWebSocketPromise = (async () => {
		try {
			const wsModule = await import('ws');
			const WsConstructor = (wsModule as { default?: typeof import('ws') }).default ?? wsModule;
			NodeWebSocket = WsConstructor as typeof import('ws');
			return NodeWebSocket;
		} catch {
			return undefined;
		}
	})();
	return NodeWebSocketPromise;
}

type NodeWsInstance = import('ws').WebSocket;
type UniversalWebSocket = WebSocket | NodeWsInstance;

interface ConnectionEpoch {
	readonly generation: number;
	readonly uri: string;
	readonly isBrowser: boolean;
	readonly promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
	socket?: UniversalWebSocket;
	timeout?: ReturnType<typeof setTimeout>;
	pingInterval?: ReturnType<typeof setInterval>;
	lastPong: number;
	messageTasks: Set<Promise<void>>;
	settled: boolean;
	established: boolean;
	invalidated: boolean;
	draining: boolean;
	disconnectedNotified: boolean;
	cleanupPromise?: Promise<void>;
}

/**
 * WebSocket transport for DAP messages.
 *
 * Every connection attempt owns an epoch. Socket handlers close over that epoch
 * and socket, so a late event can never affect a replacement connection.
 */
export class TransportWebSocket extends TransportBase {
	private _uri: string;
	private _generation = 0;
	private _epoch?: ConnectionEpoch;

	// Current-epoch mirrors retained for send() and lightweight diagnostics.
	private _websocket?: UniversalWebSocket;
	private _connectionTimeout?: ReturnType<typeof setTimeout>;
	private _pingInterval?: ReturnType<typeof setInterval>;
	private _messageTasks = new Set<Promise<void>>();
	private _cleanupOperations = new Set<Promise<void>>();

	constructor(uri = CONST_DEFAULT_SERVICE) {
		super();
		this._uri = uri;
	}

	getConnectionInfo(): string | undefined {
		return this._epoch?.uri ?? this._uri;
	}

	setUri(uri: string): void {
		if (uri === this._uri) return;

		const epoch = this._epoch;
		if (epoch) {
			this._invalidateEpoch(epoch, new Error('Connection attempt superseded by URI change'));
			this._trackCleanup(this._cleanupEpoch(epoch));
		}
		this._uri = uri;
	}

	/**
	 * Join a current same-URI attempt, or replace it with a new connection epoch.
	 */
	connect(timeout?: number): Promise<void> {
		const current = this._epoch;
		if (current && !current.invalidated && current.uri === this._uri) {
			return current.promise;
		}

		if (current) {
			this._invalidateEpoch(current, new Error('Connection attempt superseded'));
			this._trackCleanup(this._cleanupEpoch(current));
		}

		const epoch = this._createEpoch(this._uri, typeof window !== 'undefined');
		this._epoch = epoch;
		this._messageTasks = epoch.messageTasks;
		void this._openEpoch(epoch, timeout);
		return epoch.promise;
	}

	private _createEpoch(uri: string, isBrowser: boolean): ConnectionEpoch {
		let resolvePromise!: () => void;
		let rejectPromise!: (error: Error) => void;
		const promise = new Promise<void>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});

		return {
			generation: ++this._generation,
			uri,
			isBrowser,
			promise,
			resolve: resolvePromise,
			reject: rejectPromise,
			lastPong: Date.now(),
			messageTasks: new Set<Promise<void>>(),
			settled: false,
			established: false,
			invalidated: false,
			draining: false,
			disconnectedNotified: false,
		};
	}

	private async _openEpoch(epoch: ConnectionEpoch, timeout?: number): Promise<void> {
		const effectiveTimeout = timeout ?? CONST_SOCKET_TIMEOUT * 1000;
		epoch.timeout = setTimeout(() => {
			void this._handlePreOpenFailure(epoch, new Error(`Connection timeout after ${effectiveTimeout}ms`));
		}, effectiveTimeout);
		this._connectionTimeout = epoch.timeout;

		try {
			let socket: UniversalWebSocket;
			if (epoch.isBrowser) {
				socket = new WebSocket(epoch.uri);
				(socket as WebSocket).binaryType = 'arraybuffer';
			} else {
				const nodeWs = await ensureNodeWebSocket();
				if (!this._owns(epoch)) return;
				if (!nodeWs) {
					throw new Error('WebSocket library (ws) not available in Node.js environment. Install it with: npm install ws');
				}
				socket = new (nodeWs as unknown as new (url: string) => NodeWsInstance)(epoch.uri);
			}

			if (!this._owns(epoch)) {
				epoch.socket = socket;
				await this._cleanupEpoch(epoch);
				return;
			}

			epoch.socket = socket;
			this._websocket = socket;
			this._debugMessage(`Connecting to WebSocket server at ${epoch.uri}`);
			this._wireSocket(epoch, socket);
		} catch (error) {
			const setupError = error instanceof Error ? error : new Error(String(error));
			await this._handlePreOpenFailure(epoch, new Error(`Connection setup failed: ${setupError.message}`));
		}
	}

	private _wireSocket(epoch: ConnectionEpoch, socket: UniversalWebSocket): void {
		if (epoch.isBrowser) {
			const browserSocket = socket as WebSocket;
			browserSocket.onopen = () => this._handleOpen(epoch, socket);
			browserSocket.onmessage = (event: MessageEvent) => this._handleMessage(epoch, socket, event.data);
			browserSocket.onerror = () => {
				void this._handleSocketFailure(epoch, socket, new Error(`Failed to connect to ${epoch.uri}`));
			};
			browserSocket.onclose = (event: CloseEvent) => {
				const wasClean = event.code === 1000;
				const reason = event.reason || (wasClean ? 'Connection closed normally' : 'Connection closed unexpectedly');
				void this._handleClose(epoch, socket, event.code, reason);
			};
			return;
		}

		const nodeSocket = socket as NodeWsInstance;
		nodeSocket.on('open', () => this._handleOpen(epoch, socket));
		nodeSocket.on('pong', () => {
			if (!this._ownsSocket(epoch, socket)) return;
			epoch.lastPong = Date.now();
			this._debugMessage('Received pong from server');
		});
		nodeSocket.on('message', (data: import('ws').RawData, isBinary: boolean) => {
			this._handleMessage(epoch, socket, this._normaliseNodeData(data, isBinary));
		});
		nodeSocket.on('error', (error: Error) => {
			void this._handleSocketFailure(epoch, socket, error);
		});
		nodeSocket.on('close', (code: number, reason: Buffer) => {
			const wasClean = code === 1000;
			const reasonText = reason.toString() || (wasClean ? 'Connection closed normally' : 'Connection closed unexpectedly');
			void this._handleClose(epoch, socket, code, reasonText);
		});
	}

	private _normaliseNodeData(data: import('ws').RawData, isBinary: boolean): string | ArrayBuffer {
		if (!isBinary && typeof data === 'string') return data;
		if (Buffer.isBuffer(data)) {
			const arrayBuffer = new ArrayBuffer(data.length);
			new Uint8Array(arrayBuffer).set(data);
			return arrayBuffer;
		}
		if (data instanceof ArrayBuffer) return data;
		if (Array.isArray(data)) {
			const totalLength = data.reduce((sum, item) => sum + item.length, 0);
			const arrayBuffer = new ArrayBuffer(totalLength);
			const view = new Uint8Array(arrayBuffer);
			let offset = 0;
			for (const item of data) {
				view.set(item, offset);
				offset += item.length;
			}
			return arrayBuffer;
		}
		return String(data);
	}

	private _handleOpen(epoch: ConnectionEpoch, socket: UniversalWebSocket): void {
		if (!this._ownsSocket(epoch, socket)) return;
		this._clearTimeout(epoch);
		epoch.established = true;
		this._connected = true;
		this._debugMessage(`Successfully connected to ${epoch.uri}`);
		if (!epoch.isBrowser) this._startPingInterval(epoch);
		this._resolveEpoch(epoch);
	}

	private _handleMessage(epoch: ConnectionEpoch, socket: UniversalWebSocket, data: unknown): void {
		if (!this._ownsSocket(epoch, socket) || epoch.draining) return;
		if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) return;

		let settleTask!: () => void;
		const task = new Promise<void>((resolve) => {
			settleTask = resolve;
		});
		epoch.messageTasks.add(task);
		const receive = this._receiveData(epoch, data);
		void receive.then(settleTask, settleTask);
		void task.finally(() => epoch.messageTasks.delete(task));
	}

	private async _receiveData(epoch: ConnectionEpoch, data: string | ArrayBuffer): Promise<void> {
		try {
			if (!this._owns(epoch) || !epoch.established) return;
			if (typeof data === 'string') {
				await this._transportReceive(JSON.parse(data) as DAPMessage);
				return;
			}

			const dataArray = new Uint8Array(data);
			const newlinePos = dataArray.indexOf(10);
			if (newlinePos === -1) {
				const textData = new TextDecoder().decode(dataArray);
				await this._transportReceive(JSON.parse(textData) as DAPMessage);
				return;
			}

			const headerText = new TextDecoder().decode(dataArray.slice(0, newlinePos));
			const message = JSON.parse(headerText) as DAPMessage;
			message.arguments ??= {};
			message.arguments.data = dataArray.slice(newlinePos + 1);
			await this._transportReceive(message);
		} catch (error) {
			if (this._owns(epoch)) this._debugMessage(`Error processing WebSocket message: ${error}`);
		}
	}

	private async _handleSocketFailure(epoch: ConnectionEpoch, socket: UniversalWebSocket, error: Error): Promise<void> {
		if (!this._ownsSocket(epoch, socket)) return;

		if (!epoch.established) {
			await this._handlePreOpenFailure(epoch, new Error(epoch.isBrowser ? `Failed to connect to ${epoch.uri}` : `Failed to connect to ${epoch.uri}: ${error.message}`));
			return;
		}

		this._debugMessage(epoch.isBrowser ? 'WebSocket error occurred' : `WebSocket error: ${error.message}`);
		this._invalidateEpoch(epoch);
		await this._notifyAndCleanup(epoch, epoch.isBrowser ? 'WebSocket error' : `WebSocket error: ${error.message}`, true);
	}

	private async _handleClose(epoch: ConnectionEpoch, socket: UniversalWebSocket, code: number, reason: string): Promise<void> {
		if (!this._ownsSocket(epoch, socket)) return;

		if (!epoch.established) {
			await this._handlePreOpenFailure(epoch, new Error(`Connection failed: ${reason} (code: ${code})`));
			return;
		}

		this._invalidateEpoch(epoch);
		await this._notifyAndCleanup(epoch, reason, code !== 1000);
	}

	private async _handlePreOpenFailure(epoch: ConnectionEpoch, error: Error): Promise<void> {
		if (!this._owns(epoch)) return;
		this._invalidateEpoch(epoch, error);
		await this._cleanupEpoch(epoch);
	}

	private _startPingInterval(epoch: ConnectionEpoch): void {
		epoch.lastPong = Date.now();
		epoch.pingInterval = setInterval(() => {
			if (!this._owns(epoch) || !epoch.socket || !epoch.established) {
				this._stopPingInterval(epoch);
				return;
			}

			const nodeSocket = epoch.socket as NodeWsInstance;
			const elapsed = Date.now() - epoch.lastPong;
			if (elapsed > CONST_WS_PING_TIMEOUT * 1000) {
				this._debugMessage(`No pong received for ${elapsed}ms - connection dead`);
				this._stopPingInterval(epoch);
				nodeSocket.terminate();
				return;
			}

			try {
				if (nodeSocket.readyState === 1) {
					nodeSocket.ping();
					this._debugMessage('Sent ping to server');
				}
			} catch (error) {
				this._debugMessage(`Error sending ping: ${error}`);
			}
		}, CONST_WS_PING_INTERVAL * 1000);
		this._pingInterval = epoch.pingInterval;
	}

	private _stopPingInterval(epoch: ConnectionEpoch): void {
		if (!epoch.pingInterval) return;
		clearInterval(epoch.pingInterval);
		if (this._pingInterval === epoch.pingInterval) this._pingInterval = undefined;
		epoch.pingInterval = undefined;
	}

	private _clearTimeout(epoch: ConnectionEpoch): void {
		if (!epoch.timeout) return;
		clearTimeout(epoch.timeout);
		if (this._connectionTimeout === epoch.timeout) this._connectionTimeout = undefined;
		epoch.timeout = undefined;
	}

	private _resolveEpoch(epoch: ConnectionEpoch): void {
		if (epoch.settled) return;
		epoch.settled = true;
		epoch.resolve();
	}

	private _rejectEpoch(epoch: ConnectionEpoch, error: Error): void {
		if (epoch.settled) return;
		epoch.settled = true;
		epoch.reject(error);
	}

	private _invalidateEpoch(epoch: ConnectionEpoch, error?: Error): void {
		if (epoch.invalidated) return;
		epoch.invalidated = true;
		epoch.draining = true;
		this._clearTimeout(epoch);
		this._stopPingInterval(epoch);
		if (!epoch.established) this._rejectEpoch(epoch, error ?? new Error('Connection attempt cancelled'));

		if (this._epoch === epoch) {
			this._epoch = undefined;
			this._websocket = undefined;
			this._connected = false;
		}
	}

	private async _notifyDisconnected(epoch: ConnectionEpoch, reason: string, hasError: boolean): Promise<void> {
		if (!epoch.established || epoch.disconnectedNotified) return;
		epoch.disconnectedNotified = true;
		await this._transportDisconnected(reason, hasError);
	}

	private async _notifyAndCleanup(epoch: ConnectionEpoch, reason: string, hasError: boolean, excludedMessageTasks?: ReadonlySet<Promise<void>>): Promise<void> {
		const [notification, cleanup] = await Promise.allSettled([this._notifyDisconnected(epoch, reason, hasError), this._cleanupEpoch(epoch, excludedMessageTasks)]);
		if (notification.status === 'rejected') {
			this._debugMessage(`Error notifying disconnected callback: ${notification.reason}`);
		}
		if (cleanup.status === 'rejected') {
			this._debugMessage(`Error cleaning up disconnected socket: ${cleanup.reason}`);
		}
	}

	private _removeSocketListeners(epoch: ConnectionEpoch): void {
		const socket = epoch.socket;
		if (!socket) return;
		if (epoch.isBrowser) {
			const browserSocket = socket as WebSocket;
			browserSocket.onopen = null;
			browserSocket.onmessage = null;
			browserSocket.onerror = null;
			browserSocket.onclose = null;
		} else {
			(socket as NodeWsInstance).removeAllListeners();
		}
	}

	private _cleanupEpoch(epoch: ConnectionEpoch, excludedMessageTasks?: ReadonlySet<Promise<void>>): Promise<void> {
		if (epoch.cleanupPromise) return epoch.cleanupPromise;

		const cleanup = (async () => {
			epoch.draining = true;
			this._clearTimeout(epoch);
			this._stopPingInterval(epoch);
			this._removeSocketListeners(epoch);

			const tasksToDrain = Array.from(epoch.messageTasks).filter((task) => !excludedMessageTasks?.has(task));
			if (tasksToDrain.length > 0) {
				await Promise.allSettled(tasksToDrain);
			}
			epoch.messageTasks.clear();
			if (this._messageTasks === epoch.messageTasks) this._messageTasks.clear();
			await this._closeSocket(epoch);
			this._removeSocketListeners(epoch);
			epoch.socket = undefined;
		})();
		epoch.cleanupPromise = cleanup;
		this._trackCleanup(cleanup);
		return cleanup;
	}

	private async _closeSocket(epoch: ConnectionEpoch): Promise<void> {
		const socket = epoch.socket;
		if (!socket) return;

		if (epoch.isBrowser) {
			const browserSocket = socket as WebSocket;
			if (browserSocket.readyState === WebSocket.CLOSED) return;
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					browserSocket.onclose = null;
					browserSocket.onerror = null;
					resolve();
				};
				browserSocket.onclose = finish;
				browserSocket.onerror = () => {};
				const timer = setTimeout(finish, 500);
				try {
					browserSocket.close(1000, 'Disconnected by request');
				} catch {
					finish();
					return;
				}
			});
			return;
		}

		const nodeSocket = socket as NodeWsInstance;
		if (nodeSocket.readyState === 3) return;
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				nodeSocket.removeAllListeners();
				resolve();
			};
			nodeSocket.removeAllListeners();
			nodeSocket.once('error', () => {});
			nodeSocket.once('close', finish);
			const timer = setTimeout(() => {
				try {
					nodeSocket.terminate();
				} catch {
					// Best-effort final close.
				}
				finish();
			}, 500);
			try {
				nodeSocket.close(1000, 'Disconnected by request');
			} catch {
				finish();
				return;
			}
		});
	}

	private _trackCleanup(cleanup: Promise<void>): void {
		this._cleanupOperations.add(cleanup);
		void cleanup.then(
			() => this._cleanupOperations.delete(cleanup),
			() => this._cleanupOperations.delete(cleanup)
		);
	}

	private _waitForCleanups(): Promise<void> {
		if (this._cleanupOperations.size === 0) return Promise.resolve();
		return Promise.allSettled(Array.from(this._cleanupOperations)).then(() => undefined);
	}

	private _owns(epoch: ConnectionEpoch): boolean {
		return this._epoch === epoch && !epoch.invalidated;
	}

	private _ownsSocket(epoch: ConnectionEpoch, socket: UniversalWebSocket): boolean {
		return this._owns(epoch) && epoch.socket === socket;
	}

	/**
	 * Invalidates the epoch before closing it. A pre-open attempt is rejected
	 * without a disconnected callback; an established epoch publishes once.
	 */
	disconnect(): Promise<void> {
		const epoch = this._epoch;
		if (!epoch) return this._waitForCleanups();
		// A receive callback may call disconnect after one or more awaits. Do not
		// make explicit teardown wait on any current-epoch receive task: the epoch
		// is invalidated first, and DAP ownership checks suppress late publication.
		const activeMessageTasks = new Set(epoch.messageTasks);

		this._invalidateEpoch(epoch, new Error('Connection attempt cancelled by disconnect'));
		const operation = this._notifyAndCleanup(epoch, 'Disconnected by request', false, activeMessageTasks);
		this._trackCleanup(operation);
		return this._waitForCleanups();
	}

	async send(message: DAPMessage): Promise<void> {
		const epoch = this._epoch;
		const socket = this._websocket;
		if (!epoch || !socket || !this._owns(epoch) || !epoch.established || !this._connected) {
			throw new Error('WebSocket not connected. Call connect() first.');
		}

		let binaryData: Uint8Array | undefined;
		const args = message.arguments || {};

		try {
			if ('data' in args) {
				if (typeof args.data === 'string') {
					binaryData = new TextEncoder().encode(args.data);
				} else if (args.data instanceof Uint8Array) {
					binaryData = args.data;
				} else {
					binaryData = new TextEncoder().encode(JSON.stringify(args.data));
				}

				// Build and redact only when a protocol-debug callback is bound, mirroring
				// the receive path — otherwise every send pays for a walk it throws away.
				if (this._onCallerDebugProtocol) {
					const debugMessage = { ...message };
					if (debugMessage.arguments) {
						debugMessage.arguments = { ...debugMessage.arguments, data: `<${binaryData.length} bytes>` };
					}
					this._debugProtocol(`SEND: ${JSON.stringify(this._redactProtocolMessage(debugMessage))}`);
				}

				const headerMessage = { ...message };
				if (headerMessage.arguments) {
					headerMessage.arguments = { ...headerMessage.arguments };
					delete headerMessage.arguments.data;
				}

				const jsonHeader = new TextEncoder().encode(JSON.stringify(headerMessage));
				const combinedMessage = new Uint8Array(jsonHeader.length + 1 + binaryData.length);
				combinedMessage.set(jsonHeader);
				combinedMessage.set([10], jsonHeader.length);
				combinedMessage.set(binaryData, jsonHeader.length + 1);
				socket.send(combinedMessage);
			} else {
				if (this._onCallerDebugProtocol) {
					this._debugProtocol(`SEND: ${JSON.stringify(this._redactProtocolMessage(message))}`);
				}
				socket.send(JSON.stringify(message));
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'NetworkError') {
				this._debugMessage(`Connection lost during send: ${error.message}`);
				throw new Error(`Connection lost during send: ${error.message}`);
			}
			this._debugMessage(`Failed to send message: ${error}`);
			throw error;
		}
	}
}
