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

import { DAPBase } from './DAPBase';
import { DAPMessage, RocketRideClientConfig } from '../types';
import { TransportBase } from './TransportBase';
import { AuthenticationException } from '../exceptions';

/**
 * DAP (Debug Adapter Protocol) client for communicating with RocketRide servers.
 * 
 * This class implements the client side of the DAP communication protocol,
 * managing request/response correlation, pending request tracking, and message
 * sequencing. It extends DAPBase to inherit common protocol functionality.
 * 
 * Key responsibilities:
 * - Request/response correlation via sequence numbers
 * - Pending request management with promises
 * - Connection lifecycle management
 * - Message routing and handling
 * 
 * @extends DAPBase
 */
export class DAPClient extends DAPBase {
	private _pendingRequests = new Map<number, {
		resolve: (value: DAPMessage) => void;
		reject: (reason: unknown) => void;
		timer?: ReturnType<typeof setTimeout>;
	}>();
	private _sequenceNumber = 0;
	protected _requestTimeout?: number;

	constructor(module: string, transport: TransportBase | undefined, config: RocketRideClientConfig = {}) {
		super(module, transport, config);
		this._requestTimeout = config.requestTimeout;
	}

	/**
	 * Generate the next sequence number for outgoing requests.
	 */
	private getNextSeq(): number {
		return ++this._sequenceNumber;
	}

	/**
	 * Send a message to the DAP server through the transport layer.
	 */
	protected async _send(message: DAPMessage): Promise<void> {
		if (!this._transport) {
			throw new Error('Transport not available');
		}
		return this._transport.send(message);
	}

	/**
	 * Handle connection established event.
	 */
	async onConnected(connectionInfo?: string): Promise<void> {
		await super.onConnected(connectionInfo);
	}

	/**
	 * Handle connection attempt failure.
	 */
	async onConnectError(error: Error): Promise<void> {
		await super.onConnectError(error);
	}

	/**
	 * Handle disconnection event and clean up pending requests.
	 */
	async onDisconnected(reason?: string, hasError = false): Promise<void> {
		// Fail all pending requests since connection is lost
		const connectionError = new Error(reason || 'Connection lost');

		for (const [, request] of this._pendingRequests) {
			if (request.timer) clearTimeout(request.timer);
			request.reject(connectionError);
		}

		// Clear pending requests
		this._pendingRequests.clear();

		// Notify parent classes
		await super.onDisconnected(reason, hasError);
	}

	/**
	 * Handle received messages from the transport layer.
	 */
	async onReceive(message: DAPMessage): Promise<void> {
		const messageType = message.type;

		if (messageType === 'response') {
			// Handle response correlation
			const requestSeq = message.request_seq;

			if (requestSeq !== undefined && this._pendingRequests.has(requestSeq)) {
				const pendingRequest = this._pendingRequests.get(requestSeq)!;
				this._pendingRequests.delete(requestSeq);

				if (pendingRequest.timer) clearTimeout(pendingRequest.timer);
				pendingRequest.resolve(message);
			} else {
				this.debugMessage(`Response received for unknown request: ${JSON.stringify(message)}`);
			}
		} else if (messageType === 'event') {
			// Forward events to event handler
			await this.onEvent(message);
		} else {
			// Unknown message type
			this.debugMessage(`Unhandled message type: ${JSON.stringify(message)}`);
		}
	}

	/**
	 * Send a request and wait for the corresponding response.
	 * @param message - The DAP message to send
	 * @param timeout - Optional per-request timeout in ms. Overrides the default requestTimeout.
	 */
	async request(message: DAPMessage, timeout?: number): Promise<DAPMessage> {
		// Validate required fields
		if (!message.command) {
			this.raiseException(new Error("Request message must include a 'command' field"));
		}

		if (!message.type) {
			this.raiseException(new Error("Request message must include a 'type' field"));
		}

		// Verify connection
		if (!this._transport?.isConnected()) {
			this.raiseException(new Error('Server is not connected'));
		}

		// Generate sequence number for this request
		const seq = this.getNextSeq();
		message.seq = seq;

		// Create promise for response correlation
		return new Promise((resolve, reject) => {
			const entry: { resolve: typeof resolve; reject: typeof reject; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };

			// Set up request timeout if configured
			const effectiveTimeout = timeout ?? this._requestTimeout;
			if (effectiveTimeout) {
				entry.timer = setTimeout(() => {
					if (this._pendingRequests.has(seq)) {
						this._pendingRequests.delete(seq);
						reject(new Error(`Request timed out after ${effectiveTimeout}ms`));
					}
				}, effectiveTimeout);
			}

			// Store the resolve/reject functions for later use
			this._pendingRequests.set(seq, entry);

			// Send request through transport
			this._send(message)
				.catch(_error => {
					this.debugMessage(`Clearing request due to error: ${seq}`);

					// Clean up on send failure
					if (this._pendingRequests.has(seq)) {
						const pending = this._pendingRequests.get(seq)!;
						if (pending.timer) clearTimeout(pending.timer);
						this._pendingRequests.delete(seq);
					}
					reject(new Error('Could not send request'));
				});
		});
	}

	/**
	 * Establish connection to the DAP server.
	 * When the transport exposes getAuth (e.g. task service), sends auth as the first DAP command
	 * and fails connect if authentication fails.
	 * @param timeout - Optional overall timeout in ms covering both the WebSocket handshake and auth request.
	 */
	async connect(timeout?: number): Promise<void> {
		if (!this._transport) {
			throw new Error('Transport not configured');
		}

		// Track elapsed time so remaining budget can be passed to the auth request
		const start = timeout !== undefined ? Date.now() : 0;

		// Establish transport connection (socket open; no auth on the wire)
		await this._transport.connect(timeout);

		// Calculate remaining timeout for auth request
		let authTimeout: number | undefined;
		if (timeout !== undefined) {
			const elapsed = Date.now() - start;
			authTimeout = Math.max(timeout - elapsed, 0);
		}

		// First DAP message must be auth
		const auth = this._transport.getAuth() ?? '';
		const resp = await this.request({
			type: 'request',
			command: 'auth',
			seq: 0, // request() overwrites with next seq
			arguments: { auth },
		}, authTimeout);
		const success = (resp as { success?: boolean }).success;
		if (!success) {
			await this._transport.disconnect(resp.message ?? 'Authentication failed', true);
			throw new AuthenticationException(resp as unknown as Record<string, unknown>);
		}

		// Only now notify connected (transport resolved on socket open; callback runs after auth)
		const connectionInfo = this._transport.getConnectionInfo();
		await this.onConnected(connectionInfo);
	}

	/**
	 * Close connection to the DAP server and clean up resources.
	 */
	async disconnect(): Promise<void> {
		// Close transport connection
		if (this._transport) {
			await this._transport.disconnect();
		}
	}

	/**
	 * Check if connected to server.
	 */
	isConnected(): boolean {
		return this._transport?.isConnected() || false;
	}
}
