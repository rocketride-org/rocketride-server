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

import { DAPMessage, RocketRideClientConfig } from '../types/index.js';
import { TransportBase } from './TransportBase.js';

/**
 * Base class for DAP (Debug Adapter Protocol) components.
 *
 * Provides standardized logging, error handling, message building, and debugging
 * capabilities for all DAP-based components. This class handles the low-level
 * details of the protocol including message sequencing, request/response correlation,
 * and transport binding.
 *
 * Key responsibilities:
 * - Message sequence number generation
 * - Transport layer binding and lifecycle management
 * - Debug logging and protocol tracing
 * - Error handling and exception building
 * - Request/Response message construction
 *
 * @abstract This class is meant to be extended by specific DAP implementations
 */
export class DAPBase {
	protected _msgType: string;
	protected _seqCounter = 0; // Counter for generating unique message sequence numbers
	protected _transport?: TransportBase;
	protected _transportEpoch = 0;
	private _nextTransportEpoch = 0;
	protected _callDebugMessage?: (message: string) => void;
	protected _callDebugProtocol?: (message: string) => void;
	protected _logger?: unknown; // User-provided logger instance

	/**
	 * Creates a new DAPBase instance.
	 *
	 * Transport may be omitted when it will be created later in the connect path
	 * (e.g. RocketRideClient defers transport creation until connect()).
	 *
	 * @param module - Name of the module for message type identification
	 * @param transport - Transport layer for communication (optional; set later via bindTransport)
	 * @param config - Client configuration including debug callbacks
	 */
	constructor(module: string, transport: TransportBase | undefined, config: RocketRideClientConfig) {
		this._msgType = module;
		this._callDebugMessage = config.onDebugMessage;
		this._callDebugProtocol = config.onProtocolMessage;

		if (transport) this._bindTransport(transport);
	}

	/**
	 * Set the transport and bind its callbacks to this instance.
	 * Use when creating the transport lazily (e.g. in _internalConnect).
	 */
	protected _bindTransport(transport: TransportBase): void {
		const previousTransport = this._transport;
		const previousEpoch = this._transportEpoch;
		if (previousTransport) {
			this._transport = undefined;
			this._transportEpoch = ++this._nextTransportEpoch;
			this._onTransportEpochInvalidated(previousEpoch, new Error('Transport replaced'));
		}

		const epoch = ++this._nextTransportEpoch;
		this._transport = transport;
		this._transportEpoch = epoch;
		transport.bind({
			onDebugMessage: (message) => {
				if (this._isCurrentTransport(transport, epoch)) this.debugMessage(message);
			},
			onDebugProtocol: (message) => {
				if (this._isCurrentTransport(transport, epoch)) this.debugProtocol(message);
			},
			onReceive: async (message) => {
				if (!this._isCurrentTransport(transport, epoch)) return;
				await this._onTransportReceive(message, epoch);
			},
			onConnected: async (connectionInfo) => {
				if (!this._isCurrentTransport(transport, epoch)) return;
				await this.onConnected(connectionInfo);
			},
			onDisconnected: async (reason, hasError) => {
				if (!this._isCurrentTransport(transport, epoch)) return;
				this._transport = undefined;
				this._transportEpoch = ++this._nextTransportEpoch;
				this._onTransportEpochInvalidated(epoch, new Error(reason || 'Connection lost'));
				await this.onDisconnected(reason, hasError);
			},
		});
	}

	/**
	 * True only while both the bound transport identity and its DAP epoch match.
	 */
	protected _isCurrentTransport(transport: TransportBase, epoch: number): boolean {
		return this._transport === transport && this._transportEpoch === epoch;
	}

	/**
	 * Invalidate a bound transport before an explicit disconnect. Its late
	 * callbacks retain their old wrappers and are therefore ignored.
	 */
	protected _invalidateBoundTransport(transport: TransportBase, reason: Error): void {
		if (!this._isCurrentTransport(transport, this._transportEpoch)) return;
		const epoch = this._transportEpoch;
		this._transport = undefined;
		this._transportEpoch = ++this._nextTransportEpoch;
		this._onTransportEpochInvalidated(epoch, reason);
	}

	/**
	 * Hook for clients that associate work (such as pending requests) with a
	 * transport epoch.
	 */
	protected _onTransportEpochInvalidated(_epoch: number, _reason: Error): void {}

	/**
	 * Epoch-aware receive hook. Public callback signatures remain unchanged.
	 */
	protected async _onTransportReceive(message: DAPMessage, _epoch: number): Promise<void> {
		await this.onReceive(message);
	}

	/**
	 * Attempt to call a specific method, falling back to a default method.
	 *
	 * This is a utility method for dynamic method dispatch based on message commands.
	 * It first tries to call a specific handler method, then falls back to a default
	 * handler if the specific one doesn't exist.
	 *
	 * @param message - The DAP message to be handled
	 * @param methodName - Name of the specific handler method to try
	 * @param defaultName - Name of the default fallback method
	 * @returns Tuple of [handled: boolean, result: any]
	 * @protected
	 */
	protected async _callMethod(message: DAPMessage, methodName?: string, defaultName?: string): Promise<[boolean, unknown]> {
		try {
			// Dynamic dispatch to handler methods by name
			const self = this as unknown as Record<string, ((msg: DAPMessage) => Promise<unknown>) | undefined>;

			if (methodName) {
				const method = self[methodName];
				if (typeof method === 'function') {
					return [true, await method.call(this, message)];
				}
			}

			if (defaultName) {
				const method = self[defaultName];
				if (typeof method === 'function') {
					return [true, await method.call(this, message)];
				}
			}

			// No handler found
			return [false, null];
		} catch (error) {
			return [true, this.buildException(message, error as Error)];
		}
	}

	/**
	 * Generate the next sequence number for DAP message correlation.
	 */
	protected _nextSeq(): number {
		this._seqCounter += 1;
		return this._seqCounter;
	}

	/**
	 * Log an error message and throw the provided exception.
	 */
	raiseException(exception: Error): never {
		this.debugMessage(`EXCEPTION: ${exception.message}`);
		throw exception;
	}

	/**
	 * Output a general operational message with the instance's message type prefix.
	 */
	debugMessage(msg: string): void {
		if (this._callDebugMessage) {
			this._callDebugMessage(`[${this._msgType}]: ${msg}`);
		}
	}

	/**
	 * Output a protocol-level debug message for detailed DAP communication tracing.
	 */
	debugProtocol(packet: string): void {
		if (this._callDebugProtocol) {
			this._callDebugProtocol(`[${this._msgType}]: ${packet}`);
		}
	}

	/**
	 * Handle incoming DAP events from the transport layer.
	 */
	async onEvent(_event: DAPMessage): Promise<void> {
		// Override in subclasses
	}

	/**
	 * Handle transport connection establishment.
	 */
	async onConnected(_connectionInfo?: string): Promise<void> {
		// Override in subclasses
	}

	/**
	 * Handle transport disconnection and cleanup.
	 */
	async onDisconnected(_reason?: string, _hasError = false): Promise<void> {
		// Override in subclasses
	}

	/**
	 * Handle connection attempt failure.
	 */
	async onConnectError(_error: Error): Promise<void> {
		// Override in subclasses
	}

	/**
	 * Handle received messages from the transport layer.
	 */
	async onReceive(_message: DAPMessage): Promise<void> {
		// Override in subclasses
	}

	/**
	 * Check if a DAP request indicates failure based on its response fields.
	 */
	didFail(request: DAPMessage): boolean {
		return request.success === false;
	}

	/**
	 * Extract the web error details from a DAP request message.
	 */
	getWebResponse(message: DAPMessage): Record<string, unknown> {
		if (message.success !== false) {
			// Get the response body and return the web response
			const body = message.body || {};
			return { success: true, body };
		} else {
			// Get the specifics about the error
			const msg = message.message || 'Unknown error';
			const trace = message.trace;
			const file = trace?.file || null;
			const lineno = trace?.lineno || null;

			return {
				error: true,
				message: msg,
				file,
				lineno,
			};
		}
	}

	/**
	 * Build a DAP request message following the protocol specification.
	 */
	buildRequest(
		command: string,
		options: {
			token?: string;
			arguments?: Record<string, unknown>;
			data?: Uint8Array | string;
		} = {}
	): DAPMessage {
		const request: DAPMessage = {
			type: 'request',
			seq: this._nextSeq(),
			command,
		};

		if (options.token !== undefined) {
			if (!options.arguments) {
				options.arguments = {};
			}
			options.arguments.token = options.token;
		}

		if (options.arguments !== undefined) {
			request.arguments = options.arguments;
		}

		if (options.data !== undefined) {
			if (typeof options.data === 'string') {
				request.data = new TextEncoder().encode(options.data);
			} else {
				request.data = options.data;
			}
		}

		return request;
	}

	/**
	 * Build a successful DAP response message for a given request.
	 */
	buildResponse(request: DAPMessage, body?: Record<string, unknown>): DAPMessage {
		const response: DAPMessage = {
			type: 'response',
			seq: this._nextSeq(),
			request_seq: request.seq,
			command: request.command,
			success: true,
		};

		if (body !== undefined) {
			response.body = body;
		}

		return response;
	}

	/**
	 * Build a DAP event message to notify clients of state changes.
	 */
	buildEvent(
		event: string,
		options: {
			id?: string;
			body?: Record<string, unknown>;
		} = {}
	): DAPMessage {
		const message: DAPMessage = {
			type: 'event',
			seq: this._nextSeq(),
			event,
		};

		if (options.body !== undefined) {
			message.body = options.body;
		}

		if (options.id !== undefined) {
			if (!message.body) {
				message.body = {};
			}
			message.body.__id = options.id;
		}

		return message;
	}

	/**
	 * Build a DAP error response.
	 */
	buildError(request: DAPMessage, message: string): DAPMessage {
		const response: DAPMessage = {
			type: 'response',
			seq: this._nextSeq(),
			request_seq: request.seq,
			command: request.command,
			success: false,
			message,
		};

		try {
			// Get the call stack for debugging
			const stack = new Error().stack;
			if (stack) {
				const lines = stack.split('\n');
				if (lines.length >= 3) {
					// Extract filename and line from stack trace
					const callerLine = lines[2];
					const match = callerLine.match(/at .* \((.+):(\d+):\d+\)/);
					if (match) {
						const filename = match[1].split('/').pop() || match[1];
						const lineno = parseInt(match[2], 10);
						response.trace = { file: filename, lineno };
					}
				}
			}
		} catch {
			// Not critical if we can't add trace info
		}

		return response;
	}

	/**
	 * Build a DAP exception response with debugging information.
	 */
	buildException(request: DAPMessage, error: Error): DAPMessage {
		const response: DAPMessage = {
			type: 'response',
			seq: this._nextSeq(),
			request_seq: request.seq,
			command: request.command,
			success: false,
			message: error.message,
		};

		// Extract traceback information from the exception
		if (error.stack) {
			const lines = error.stack.split('\n');
			if (lines.length >= 2) {
				const errorLine = lines[1];
				const match = errorLine.match(/at .* \((.+):(\d+):\d+\)/);
				if (match) {
					const filename = match[1].split('/').pop() || match[1];
					const lineno = parseInt(match[2], 10);
					response.trace = { file: filename, lineno };
				}
			}
		}

		return response;
	}
}
