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

import { DAPMessage, TransportCallbacks } from '../types';

/**
 * Abstract base class for DAP transport implementations.
 *
 * This class defines the standard interface that all transport implementations
 * must follow for DAP communication. It provides common functionality for
 * callback management, connection state tracking, and debug message routing.
 *
 * Concrete implementations must provide:
 * - connect(): Establish the transport connection
 * - disconnect(): Close the transport connection
 * - send(): Transmit a DAP message
 *
 * @abstract This class must be extended by concrete transport implementations
 */
export abstract class TransportBase {
	protected _connected = false;
	protected _onCallerDebugMessage?: (message: string) => void;
	protected _onCallerDebugProtocol?: (message: string) => void;
	protected _onCallerReceive?: (message: DAPMessage) => Promise<void>;
	protected _onCallerConnected?: (connectionInfo?: string) => Promise<void>;
	protected _onCallerDisconnected?: (reason?: string, hasError?: boolean) => Promise<void>;

	/**
	 * Send debug message to callback if available.
	 */
	protected _debugMessage(message: string): void {
		if (this._onCallerDebugMessage) {
			this._onCallerDebugMessage(message);
		}
	}

	/**
	 * Send protocol debug message to callback if available.
	 */
	protected _debugProtocol(message: string): void {
		if (this._onCallerDebugProtocol) {
			this._onCallerDebugProtocol(message);
		}
	}

	/**
	 * Forward received message to callback if available.
	 */
	protected async _transportReceive(message: DAPMessage): Promise<void> {
		this._debugProtocol(`RECV: ${JSON.stringify(message)}`);
		if (this._onCallerReceive) {
			await this._onCallerReceive(message);
		}
	}

	/**
	 * Connection info for the "connected" callback (e.g. URI). Default none.
	 */
	getConnectionInfo(): string | undefined {
		return undefined;
	}

	/**
	 * Notify about connection establishment.
	 */
	protected async _transportConnected(connectionInfo?: string): Promise<void> {
		this._debugMessage(`Connected, info=${connectionInfo}`);
		if (this._onCallerConnected) {
			await this._onCallerConnected(connectionInfo);
		}
	}

	/**
	 * Notify about connection closure.
	 */
	protected async _transportDisconnected(reason?: string, hasError = false): Promise<void> {
		this._debugMessage(`Disconnected, reason=${reason}, error=${hasError}`);
		if (this._onCallerDisconnected) {
			await this._onCallerDisconnected(reason, hasError);
		}
	}

	/**
	 * Bind callback functions to the transport.
	 *
	 * This must be called before using the transport for communication.
	 * The callbacks handle debugging, connection events, and message processing.
	 */
	bind(callbacks: TransportCallbacks): void {
		if (callbacks.onDebugMessage) {
			this._onCallerDebugMessage = callbacks.onDebugMessage;
		}
		if (callbacks.onDebugProtocol) {
			this._onCallerDebugProtocol = callbacks.onDebugProtocol;
		}
		if (callbacks.onReceive) {
			this._onCallerReceive = callbacks.onReceive;
		}
		if (callbacks.onConnected) {
			this._onCallerConnected = callbacks.onConnected;
		}
		if (callbacks.onDisconnected) {
			this._onCallerDisconnected = callbacks.onDisconnected;
		}
	}

	/**
	 * Auth credential for connect flow (e.g. first DAP auth command). Default none.
	 */
	getAuth(): string | undefined {
		return undefined;
	}

	/**
	 * Update auth credential. Takes effect on the next connect().
	 */
	setAuth(_auth: string): void {}

	/**
	 * Update connection URI. Takes effect on the next connect().
	 */
	setUri(_uri: string): void {}

	/**
	 * Check if the transport is currently connected.
	 */
	isConnected(): boolean {
		return this._connected;
	}

	/**
	 * Establish connection to remote endpoint (client-side).
	 * @param timeout - Optional connection timeout in milliseconds. Falls back to default when not provided.
	 */
	async connect(_timeout?: number): Promise<void> {
		// Default implementation - override in concrete classes
	}

	/**
	 * Accept incoming connection (server-side).
	 */
	async accept(_connectionInfo: unknown): Promise<void> {
		// Default implementation - override in concrete classes
	}

	/**
	 * Close connection and cleanup resources.
	 */
	abstract disconnect(): Promise<void>;

	/**
	 * Send a message over the transport.
	 */
	abstract send(message: DAPMessage): Promise<void>;
}
