/**
 * MIT License
 * 
 * Copyright (c) 2026 RocketRide, Inc.
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

import { TransportBase } from './TransportBase';
import { DAPMessage } from '../types';
import { CONST_DEFAULT_SERVICE, CONST_SOCKET_TIMEOUT, CONST_WS_PING_INTERVAL, CONST_WS_PING_TIMEOUT } from '../constants';

/**
 * Node.js WebSocket (ws package) loading - ESM/CJS compatibility
 *
 * We use dynamic import() instead of require() because:
 * - In ESM (type: "module"), require is not defined; require('ws') throws ReferenceError at load time
 * - The package is dual-mode (exports both CJS and ESM builds); ESM consumers would hit this
 *
 * Loading is deferred until connect() (lazy) so:
 * - Browser builds never load ws (no window check needed at module load)
 * - Single load is cached; concurrent connect() calls share the same promise
 *
 * Install ws in Node.js projects: npm install ws
 */
let NodeWebSocket: typeof import('ws') | undefined;
let NodeWebSocketPromise: Promise<typeof import('ws') | undefined> | null = null;

async function ensureNodeWebSocket(): Promise<typeof import('ws') | undefined> {
	if (NodeWebSocket !== undefined) return NodeWebSocket;
	if (typeof window !== 'undefined') return undefined;
	if (NodeWebSocketPromise) return NodeWebSocketPromise;
	NodeWebSocketPromise = (async () => {
		try {
			const wsModule = await import('ws');
			// ESM interop: default export is the constructor; CJS-style modules may expose it directly
			const WsConstructor = (wsModule as { default?: typeof import('ws') }).default ?? wsModule;
			NodeWebSocket = WsConstructor as typeof import('ws');
			return NodeWebSocket;
		} catch {
			return undefined;
		}
	})();
	return NodeWebSocketPromise;
}

// Type for Node.js ws WebSocket instance
type NodeWsInstance = import('ws').WebSocket;

// Type that works for both browser and Node.js WebSocket
type UniversalWebSocket = WebSocket | NodeWsInstance;

/**
 * WebSocket transport implementation for DAP protocol communication.
 * 
 * Provides WebSocket-based communication between RocketRide clients and servers
 * with support for both text (JSON) and binary (CBOR) message formats. Handles
 * connection lifecycle management, message serialization/deserialization, automatic
 * heartbeat/ping messages, and connection timeout detection.
 * 
 * Features:
 * - Cross-platform: Works in both browser (native WebSocket) and Node.js (ws library)
 * - Automatic message encoding/decoding (JSON and CBOR)
 * - Connection timeout handling
 * - Authentication via headers
 * - Message queuing during connection
 * 
 * @extends TransportBase
 */
export class TransportWebSocket extends TransportBase {
	private _websocket?: UniversalWebSocket | null;
	private _uri: string;
	private _auth?: string;
	private _messageTasks = new Set<Promise<void>>();
	private _connectionTimeout?: ReturnType<typeof setTimeout>;
	private _pingInterval?: ReturnType<typeof setInterval>;
	private _lastPong: number = Date.now();

	constructor(uri = CONST_DEFAULT_SERVICE, auth?: string) {
		super();
		this._uri = uri;
		this._auth = auth;
	}

	/** Auth credential for use by connect flow (e.g. first DAP auth command). */
	getAuth(): string | undefined {
		return this._auth;
	}

	/** Connection info for the "connected" callback (URI). */
	getConnectionInfo(): string | undefined {
		return this._uri;
	}

	/** Update auth credential. Takes effect on the next connect(). */
	setAuth(auth: string): void { this._auth = auth; }

	/** Update connection URI. Takes effect on the next connect(). */
	setUri(uri: string): void { this._uri = uri; }

	/**
	 * Start ping interval for Node.js WebSocket connections.
	 * Sends ping frames at regular intervals and monitors for pong responses.
	 * If no pong is received within the timeout period, the connection is terminated.
	 */
	private _startPingInterval(): void {
		// Only for Node.js WebSocket (browser handles ping/pong automatically)
		if (typeof window !== 'undefined' || !this._websocket) {
			return;
		}

		this._lastPong = Date.now();

		this._pingInterval = setInterval(() => {
			if (!this._connected || !this._websocket) {
				this._stopPingInterval();
				return;
			}

			// Cast to Node.js WebSocket type for ping/terminate methods
			const nodeWs = this._websocket as NodeWsInstance;

			// Check if we've received a pong within the timeout period
			const timeSinceLastPong = Date.now() - this._lastPong;
			if (timeSinceLastPong > CONST_WS_PING_TIMEOUT * 1000) {
				this._debugMessage(`No pong received for ${timeSinceLastPong}ms - connection dead`);
				this._stopPingInterval();
				nodeWs.terminate();
				return;
			}

			// Send ping
			try {
				if (nodeWs.readyState === 1) { // OPEN state
					nodeWs.ping();
					this._debugMessage('Sent ping to server');
				}
			} catch (error) {
				this._debugMessage(`Error sending ping: ${error}`);
			}
		}, CONST_WS_PING_INTERVAL * 1000);
	}

	/**
	 * Stop the ping interval timer.
	 */
	private _stopPingInterval(): void {
		if (this._pingInterval) {
			clearInterval(this._pingInterval);
			this._pingInterval = undefined;
		}
	}

	/**
	 * Process raw WebSocket data into structured messages.
	 * 
	 * Handles both JSON text messages and DAP binary format messages.
	 * Binary messages use format: JSON header + newline + binary payload.
	 */
	private async _receiveData(data: string | ArrayBuffer): Promise<void> {
		try {
			if (!this._connected) {
				return;
			}

			if (typeof data === 'string') {
				// JSON text message
				const jsonMessage = JSON.parse(data);
				await this._transportReceive(jsonMessage);
			} else {
				// Binary message - look for JSON header separator
				const dataArray = new Uint8Array(data);
				const newlinePos = dataArray.indexOf(10); // ASCII newline

				if (newlinePos === -1) {
					// No separator - treat as JSON text
					const textData = new TextDecoder().decode(dataArray);
					const jsonMessage = JSON.parse(textData);
					await this._transportReceive(jsonMessage);
				} else {
					// DAP binary format: JSON header + newline + binary data
					const jsonHeader = dataArray.slice(0, newlinePos);
					const binaryData = dataArray.slice(newlinePos + 1);

					// Parse JSON header
					const headerText = new TextDecoder().decode(jsonHeader);
					const jsonMessage = JSON.parse(headerText);

					// Add binary data to message arguments
					if (!jsonMessage.arguments) {
						jsonMessage.arguments = {};
					}
					jsonMessage.arguments.data = binaryData;
					await this._transportReceive(jsonMessage);
				}
			}
		} catch (error) {
			// Only log errors if still connected
			if (this._connected) {
				this._debugMessage(`Error processing WebSocket message: ${error}`);
			}
		}
	}

	/**
	 * Connect to WebSocket server and start receiving messages.
	 * Works in both browser and Node.js environments.
	 */
	async connect(timeout?: number): Promise<void> {
		const isBrowser = typeof window !== 'undefined';
		let nodeWs: typeof import('ws') | undefined;
		if (!isBrowser) {
			// Must load ws before creating the connection; ensureNodeWebSocket() uses dynamic import()
			// so it works when this package is consumed as ESM (e.g. from a project with "type": "module")
			nodeWs = await ensureNodeWebSocket();
			if (!nodeWs) {
				throw new Error('WebSocket library (ws) not available in Node.js environment. Install it with: npm install ws');
			}
		}

		return new Promise((resolve, reject) => {
			let promiseResolved = false;

			const resolveOnce = () => {
				if (!promiseResolved) {
					promiseResolved = true;
					resolve();
				}
			};

			const rejectOnce = (error: Error) => {
				if (!promiseResolved) {
					promiseResolved = true;
					reject(error);
				}
			};

			try {
				this._debugMessage(`Connecting to WebSocket server at ${this._uri}`);

				if (this._connectionTimeout) {
					clearTimeout(this._connectionTimeout);
					this._connectionTimeout = undefined;
				}

				if (isBrowser) {
					// ============================================================
					// BROWSER WebSocket (native API)
					// ============================================================
					// Connect without auth on URL; first DAP message must be auth (sent by connect flow via request())
					const wsUrl = this._uri;

					this._websocket = new WebSocket(wsUrl);
					this._websocket.binaryType = 'arraybuffer';

					this._websocket.onopen = async () => {
						if (this._connectionTimeout) {
							clearTimeout(this._connectionTimeout);
							this._connectionTimeout = undefined;
						}

						this._connected = true;
						this._debugMessage(`Successfully connected to ${this._uri}`);
						// Resolve so DAPClient can send auth; do not fire _transportConnected until after auth
						resolveOnce();
					};

					this._websocket.onmessage = async (event: MessageEvent) => {
						const data = typeof event.data === 'string' ? event.data : event.data;
						const task = this._receiveData(data);
						this._messageTasks.add(task);
						task.finally(() => this._messageTasks.delete(task));
					};

				this._websocket.onclose = async (event: CloseEvent) => {
					if (this._connectionTimeout) {
						clearTimeout(this._connectionTimeout);
						this._connectionTimeout = undefined;
					}

					this._connected = false;
					const wasClean = event.code === 1000;
					const reasonText = event.reason || (wasClean ? 'Connection closed normally' : 'Connection closed unexpectedly');

					// Always notify disconnection to enable reconnection
					await this._transportDisconnected(reasonText, !wasClean);

					if (!promiseResolved) {
						rejectOnce(new Error(`Connection failed: ${reasonText} (code: ${event.code})`));
					}
				};

					this._websocket.onerror = async () => {
						if (this._connectionTimeout) {
							clearTimeout(this._connectionTimeout);
							this._connectionTimeout = undefined;
						}

						this._connected = false;
						this._debugMessage(`WebSocket error occurred`);

						// Close the websocket and release for garbage collection
						if (this._websocket) {
							try {
								(this._websocket as WebSocket).close();
							} catch {
								// Ignore close errors
							}
							this._websocket = null;
						}

						if (!promiseResolved) {
							rejectOnce(new Error(`Failed to connect to ${this._uri}`));
						} else {
							await this._transportDisconnected('WebSocket error', true);
						}
					};

				} else {
					// ============================================================
					// NODE.JS WebSocket (ws library)
					// ============================================================
					// nodeWs is the WebSocket constructor from 'ws' (loaded above via ensureNodeWebSocket)
					// ws exports the constructor directly: new WebSocket(url)
					this._websocket = new (nodeWs as new (url: string) => NodeWsInstance)(this._uri);

					this._websocket.on('open', async () => {
						if (this._connectionTimeout) {
							clearTimeout(this._connectionTimeout);
							this._connectionTimeout = undefined;
						}

						this._connected = true;
						this._debugMessage(`Successfully connected to ${this._uri}`);
						// Start ping/pong heartbeat for Node.js WebSocket
						this._startPingInterval();
						// Resolve so DAPClient can send auth; do not fire _transportConnected until after auth
						resolveOnce();
					});

					// Handle pong responses to track connection health
					this._websocket.on('pong', () => {
						this._lastPong = Date.now();
						this._debugMessage('Received pong from server');
					});

					this._websocket.on('message', async (data: import('ws').RawData, isBinary: boolean) => {
						// Convert to string or ArrayBuffer for compatibility
						let messageData: string | ArrayBuffer;
						if (!isBinary && typeof data === 'string') {
							messageData = data;
						} else if (Buffer.isBuffer(data)) {
							// Convert Buffer to ArrayBuffer
							const arrayBuffer = new ArrayBuffer(data.length);
							const view = new Uint8Array(arrayBuffer);
							view.set(data);
							messageData = arrayBuffer;
						} else if (data instanceof ArrayBuffer) {
							messageData = data;
						} else if (Array.isArray(data)) {
							// Buffer[] - concatenate into single ArrayBuffer
							const totalLength = data.reduce((sum, buf) => sum + buf.length, 0);
							const arrayBuffer = new ArrayBuffer(totalLength);
							const view = new Uint8Array(arrayBuffer);
							let offset = 0;
							for (const buf of data) {
								view.set(buf, offset);
								offset += buf.length;
							}
							messageData = arrayBuffer;
						} else {
							// Fallback: treat as string
							messageData = String(data);
						}
						const task = this._receiveData(messageData);
						this._messageTasks.add(task);
						task.finally(() => this._messageTasks.delete(task));
					});

				this._websocket.on('close', async (code: number, reason: Buffer) => {
					if (this._connectionTimeout) {
						clearTimeout(this._connectionTimeout);
						this._connectionTimeout = undefined;
					}

					this._connected = false;
					const wasClean = code === 1000;
					const reasonText = (reason ? reason.toString() : '') || (wasClean ? 'Connection closed normally' : 'Connection closed unexpectedly');

					// Always notify disconnection to enable reconnection
					await this._transportDisconnected(reasonText, !wasClean);

					if (!promiseResolved) {
						rejectOnce(new Error(`Connection failed: ${reasonText} (code: ${code})`));
					}
				});

					this._websocket.on('error', async (error: Error) => {
						if (this._connectionTimeout) {
							clearTimeout(this._connectionTimeout);
							this._connectionTimeout = undefined;
						}

						this._connected = false;
						this._debugMessage(`WebSocket error: ${error.message}`);

						// Close the websocket and release for garbage collection
						if (this._websocket) {
							try {
								this._websocket.close();
							} catch {
								// Ignore close errors
							}
							this._websocket = null;
						}

						if (!promiseResolved) {
							rejectOnce(new Error(`Failed to connect to ${this._uri}: ${error.message}`));
						} else {
							await this._transportDisconnected(`WebSocket error: ${error.message}`, true);
						}
					});
				}

				// Set connection timeout (works same in both environments)
				const effectiveTimeout = timeout ?? CONST_SOCKET_TIMEOUT * 1000;
				this._connectionTimeout = setTimeout(() => {
					if (this._connectionTimeout) {
						clearTimeout(this._connectionTimeout);
						this._connectionTimeout = undefined;
					}

					// Force close WebSocket if still connecting and release for GC
					if (this._websocket) {
						if (isBrowser) {
							(this._websocket as WebSocket).close();
						} else {
							this._websocket.close();
						}
						this._websocket = null;
					}

					rejectOnce(new Error(`Connection timeout after ${effectiveTimeout}ms`));
				}, effectiveTimeout);

			} catch (error) {
				if (this._connectionTimeout) {
					clearTimeout(this._connectionTimeout);
					this._connectionTimeout = undefined;
				}
				this._debugMessage(`Failed to connect to ${this._uri}: ${error}`);
				rejectOnce(new Error(`Connection setup failed: ${error}`));
			}
		});
	}

	/**
	 * Disconnect and close the WebSocket connection gracefully.
	 * Works in both browser and Node.js environments.
	 * @param reason - Optional reason for disconnection (reported to onDisconnected).
	 * @param hasError - Optional; when true, report as error to onDisconnected.
	 */
	async disconnect(reason?: string, hasError?: boolean): Promise<void> {
		// Clear any pending connection timeout
		if (this._connectionTimeout) {
			clearTimeout(this._connectionTimeout);
			this._connectionTimeout = undefined;
		}

		// Stop ping interval
		this._stopPingInterval();

		if (!this._connected || !this._websocket) {
			return;
		}

		let callbackCalled = false;
		const isBrowser = typeof window !== 'undefined';

		try {
			this._debugMessage('Gracefully disconnecting WebSocket');

			// Cancel pending message processing tasks
			if (this._messageTasks.size > 0) {
				this._debugMessage(`Waiting for ${this._messageTasks.size} pending message tasks`);
				await Promise.allSettled(Array.from(this._messageTasks));
				this._debugMessage('Message tasks completed');
			}

			// Close WebSocket and wait for complete closure
			if (this._websocket) {
				const ws = this._websocket;

				if (isBrowser) {
					// Browser WebSocket
					const browserWs = ws as WebSocket;

					const closePromise = new Promise<void>((resolve) => {
						if (browserWs.readyState === WebSocket.CLOSED) {
							resolve();
							return;
						}

						let resolved = false;

						const resolveOnce = (timerId?: ReturnType<typeof setTimeout>) => {
							if (!resolved) {
								resolved = true;
								if (timerId) clearTimeout(timerId);
								browserWs.onclose = null;
								resolve();
							}
						};

						browserWs.close(1000, 'Disconnected by request');

						const timeoutId = setTimeout(() => {
							this._debugMessage('WebSocket close timeout - forcing resolution');
							resolveOnce();
						}, 500);

						browserWs.onclose = () => {
							this._debugMessage('WebSocket close event received');
							resolveOnce(timeoutId);
						};
					});

					await closePromise;

				} else {
					// Node.js WebSocket
					(ws as NodeWsInstance).removeAllListeners();

					const closePromise = new Promise<void>((resolve) => {
						if (ws.readyState === 3) { // CLOSED state
							resolve();
							return;
						}

						let resolved = false;
						const nodeWs = ws as NodeWsInstance;

						const resolveOnce = (timerId?: ReturnType<typeof setTimeout>) => {
							if (!resolved) {
								resolved = true;
								if (timerId) clearTimeout(timerId);
								resolve();
							}
						};

						const tempCloseHandler = () => {
							this._debugMessage('WebSocket close event received');
							resolveOnce(timeoutId);
						};

						nodeWs.on('close', tempCloseHandler);
						ws.close(1000, 'Disconnected by request');

						const timeoutId = setTimeout(() => {
							nodeWs.removeListener('close', tempCloseHandler);
							this._debugMessage('WebSocket close timeout - forcing resolution');
							resolveOnce();
						}, 500);
					});

					await closePromise;
				}
			}

			this._debugMessage('WebSocket disconnected successfully');

			// Notify about disconnection (use caller-provided reason/hasError when given)
			await this._transportDisconnected(reason ?? 'Disconnected by request', hasError ?? false);
			callbackCalled = true;

		} catch (error) {
			this._debugMessage(`Error during disconnect: ${error}`);
			if (!callbackCalled) {
				await this._transportDisconnected(`Disconnect error: ${error}`, true);
				callbackCalled = true;
			}
		} finally {
			// Always clean up resources
			this._connected = false;
			this._websocket = undefined;
			this._messageTasks.clear();
			this._debugMessage('Disconnect cleanup completed');
		}
	}

	/**
	 * Send a DAP message with automatic format selection.
	 * 
	 * Handles both standard JSON messages and DAP binary messages with
	 * data payloads. Automatically chooses appropriate WebSocket message
	 * format based on message content.
	 * 
	 * Works in both browser and Node.js environments.
	 */
	async send(message: DAPMessage): Promise<void> {
		if (!this.isConnected()) {
			throw new Error('WebSocket not connected. Call connect() first.');
		}

		if (!this._websocket) {
			throw new Error('WebSocket connection lost before send');
		}

		let binaryData: Uint8Array | undefined;
		const args = message.arguments || {};

		try {
			if ('data' in args) {
				// Binary message - use DAP binary format
				if (typeof args.data === 'string') {
					binaryData = new TextEncoder().encode(args.data);
				} else if (args.data instanceof Uint8Array) {
					binaryData = args.data;
				} else {
					binaryData = new TextEncoder().encode(JSON.stringify(args.data));
				}

				// Create debug version for logging
				const debugMessage = { ...message };
				if (debugMessage.arguments) {
					debugMessage.arguments = { ...debugMessage.arguments };
					debugMessage.arguments.data = `<${binaryData.length} bytes>`;
				}
				this._debugProtocol(`SEND: ${JSON.stringify(debugMessage)}`);

				// Remove data from message for header
				const headerMessage = { ...message };
				if (headerMessage.arguments) {
					headerMessage.arguments = { ...headerMessage.arguments };
					delete headerMessage.arguments.data;
				}

				// Create DAP binary message: JSON header + newline + binary data
				const jsonHeader = new TextEncoder().encode(JSON.stringify(headerMessage));
				const newline = new Uint8Array([10]); // ASCII newline
				const combinedMessage = new Uint8Array(jsonHeader.length + 1 + binaryData.length);
				combinedMessage.set(jsonHeader);
				combinedMessage.set(newline, jsonHeader.length);
				combinedMessage.set(binaryData, jsonHeader.length + 1);

				// Send binary message
				this._websocket.send(combinedMessage);

			} else {
				// Standard JSON message
				this._debugProtocol(`SEND: ${JSON.stringify(message)}`);
				this._websocket.send(JSON.stringify(message));
			}

		} catch (error) {
			if (error instanceof Error && error.name === 'NetworkError') {
				// Connection errors should update state
				this._connected = false;
				this._debugMessage(`Connection lost during send: ${error.message}`);
				throw new Error(`Connection lost during send: ${error.message}`);
			} else {
				// Log send failures for debugging
				this._debugMessage(`Failed to send message: ${error}`);
				throw error;
			}
		}
	}
}
