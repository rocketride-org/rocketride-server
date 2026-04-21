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

import { DAPBase } from './DAPBase.js';
import { DAPMessage, RocketRideClientConfig } from '../types/index.js';
import { TransportBase } from './TransportBase.js';
import { AuthenticationException } from '../exceptions/index.js';
import { SDK_VERSION } from '../constants.js';

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
	/**
	 * Map of outstanding requests awaiting a server response.
	 * Keyed by the message sequence number assigned at send time.
	 * Each entry holds the Promise resolve/reject callbacks and an optional
	 * timeout handle so the request can be cancelled if the server is silent.
	 */
	private _pendingRequests = new Map<
		number,
		{
			resolve: (value: DAPMessage) => void;
			reject: (reason: unknown) => void;
			timer?: ReturnType<typeof setTimeout>;
		}
	>();

	/**
	 * Monotonically increasing counter used to assign unique sequence numbers
	 * to every outgoing request. Responses echo this number in `request_seq`
	 * so they can be matched back to the originating request.
	 */
	private _sequenceNumber = 0;

	/**
	 * Default timeout in milliseconds applied to every request unless overridden
	 * by the per-call `timeout` parameter. `undefined` means no timeout.
	 */
	protected _requestTimeout?: number;

	/**
	 * Human-readable name of this client (e.g. "VS Code", "TypeScript SDK").
	 * Sent to the server during authentication so operators can identify callers.
	 */
	protected _clientDisplayName?: string;

	/**
	 * Version string of this client (e.g. "0.9.4").
	 * Sent alongside `_clientDisplayName` during authentication.
	 */
	protected _clientDisplayVersion?: string;

	/**
	 * Creates a DAPClient instance and configures request-timeout and client
	 * identity fields from the provided config object.
	 *
	 * @param module - Logical name for this client instance (used in debug messages)
	 * @param transport - Optional pre-built transport; may be provided later via _bindTransport
	 * @param config - Client configuration options (timeout, display name/version)
	 */
	constructor(module: string, transport: TransportBase | undefined, config: RocketRideClientConfig = {}) {
		// Delegate module name, transport, and shared config to DAPBase
		super(module, transport, config);

		// Capture the default per-request timeout (undefined = no timeout)
		this._requestTimeout = config.requestTimeout;

		// Resolve the display name the client will advertise to the server during auth
		this._clientDisplayName = config.clientName || 'TypeScript SDK';

		// Resolve the version string the client will advertise to the server during auth
		this._clientDisplayVersion = config.clientVersion || SDK_VERSION;
	}

	/**
	 * Generate the next sequence number for outgoing requests.
	 *
	 * Increments the internal counter and returns the new value.
	 * The counter never resets within a client lifetime, ensuring
	 * uniqueness across all requests on a single connection.
	 */
	private getNextSeq(): number {
		// Pre-increment so seq numbers start at 1, not 0 (0 is the unset sentinel)
		return ++this._sequenceNumber;
	}

	/**
	 * Send a message to the DAP server through the transport layer.
	 *
	 * Delegates directly to the active transport's `send` method.
	 * Throws if no transport is currently bound.
	 *
	 * @param message - The fully assembled DAP message to transmit
	 * @throws Error if no transport is available (client not connected)
	 */
	protected async _send(message: DAPMessage): Promise<void> {
		// Guard: a transport must be present before any message can be sent
		if (!this._transport) {
			throw new Error('Transport not available');
		}

		// Delegate serialisation and transmission to the transport implementation
		return this._transport.send(message);
	}

	/**
	 * Handle connection established event.
	 *
	 * Chains to the parent DAPBase implementation which clears any
	 * internal error state and invokes registered connection callbacks.
	 *
	 * @param connectionInfo - Optional human-readable description of the connection
	 */
	async onConnected(connectionInfo?: string): Promise<void> {
		// Propagate to DAPBase so shared housekeeping runs
		await super.onConnected(connectionInfo);
	}

	/**
	 * Handle connection attempt failure.
	 *
	 * Chains to the parent DAPBase implementation for shared error handling.
	 *
	 * @param error - The error that caused the connection attempt to fail
	 */
	async onConnectError(error: Error): Promise<void> {
		// Propagate to DAPBase for centralised error handling
		await super.onConnectError(error);
	}

	/**
	 * Handle disconnection event and clean up pending requests.
	 *
	 * When the connection is lost all outstanding requests are immediately
	 * rejected with a "connection lost" error so callers don't wait forever.
	 * After cleanup the event is propagated to parent classes.
	 *
	 * @param reason - Human-readable reason for the disconnection
	 * @param hasError - Whether the disconnection was caused by an error condition
	 */
	async onDisconnected(reason?: string, hasError = false): Promise<void> {
		// Create a single error object reused for rejecting all pending requests,
		// preserving the disconnect reason as the error message
		const connectionError = new Error(reason || 'Connection lost');

		// Cancel all pending requests: clear their timers and reject the promises
		// so callers receive a prompt error instead of hanging indefinitely
		for (const [, request] of this._pendingRequests) {
			// Clear the per-request timeout handle to avoid a stale timer firing
			if (request.timer) clearTimeout(request.timer);
			// Reject with the connection-lost error
			request.reject(connectionError);
		}

		// Remove all entries now that every promise has been settled
		this._pendingRequests.clear();

		// Propagate to DAPBase / RocketRideClient for additional cleanup
		await super.onDisconnected(reason, hasError);
	}

	/**
	 * Handle received messages from the transport layer.
	 *
	 * Routes incoming messages to the appropriate handler based on their type:
	 * - `response`: matched to a pending request via `request_seq` and resolved
	 * - `event`: forwarded to `onEvent` for user-defined processing
	 * - anything else: logged as an unhandled message type
	 *
	 * @param message - The DAP message received from the server
	 */
	async onReceive(message: DAPMessage): Promise<void> {
		const messageType = message.type;

		if (messageType === 'response') {
			// --- Response path: correlate with the originating request ---

			// The server echoes back the client's sequence number in request_seq
			const requestSeq = message.request_seq;

			if (requestSeq !== undefined && this._pendingRequests.has(requestSeq)) {
				// Retrieve and remove the pending entry atomically to avoid double-resolve
				const pendingRequest = this._pendingRequests.get(requestSeq)!;
				this._pendingRequests.delete(requestSeq);

				// Cancel the per-request timeout now that the response has arrived
				if (pendingRequest.timer) clearTimeout(pendingRequest.timer);

				// Settle the promise with the server's response message
				pendingRequest.resolve(message);
			} else {
				// Response arrived for a request we no longer track (timed out, or spurious)
				this.debugMessage(`Response received for unknown request: ${JSON.stringify(message)}`);
			}
		} else if (messageType === 'event') {
			// --- Event path: server-pushed notifications (status updates, pipeline events) ---
			// Delegate to the virtual onEvent handler (overridden by RocketRideClient)
			await this.onEvent(message);
		} else {
			// --- Unknown message type: log for diagnostics ---
			this.debugMessage(`Unhandled message type: ${JSON.stringify(message)}`);
		}
	}

	/**
	 * Send a request and wait for the corresponding response.
	 *
	 * Assigns a unique sequence number to the message, registers a pending
	 * promise, starts an optional timeout, transmits the message via the
	 * transport, and returns the server's response when it arrives.
	 *
	 * @param message - The DAP message to send (must have `command` and `type` set)
	 * @param timeout - Optional per-request timeout in ms. Overrides the default requestTimeout.
	 * @returns Promise that resolves with the server's response DAPMessage
	 * @throws Error if the message is malformed, the client is not connected, or the request times out
	 */
	async request(message: DAPMessage, timeout?: number): Promise<DAPMessage> {
		// Validate required fields before touching the network
		if (!message.command) {
			this.raiseException(new Error("Request message must include a 'command' field"));
		}

		if (!message.type) {
			this.raiseException(new Error("Request message must include a 'type' field"));
		}

		// Guard: refuse to queue a request when the transport is not connected
		if (!this._transport?.isConnected()) {
			this.raiseException(new Error('Server is not connected'));
		}

		// Assign the next monotonically increasing sequence number to this request
		// so the matching response can be correlated back
		const seq = this.getNextSeq();
		message.seq = seq;

		// Return a promise whose resolve/reject are stored in _pendingRequests
		// and will be called when a matching response arrives (or on timeout/error)
		return new Promise((resolve, reject) => {
			const entry: { resolve: typeof resolve; reject: typeof reject; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };

			// Determine the effective timeout: per-call override takes priority over
			// the instance-level default; undefined means no timeout
			const effectiveTimeout = timeout ?? this._requestTimeout;
			if (effectiveTimeout) {
				// Schedule automatic rejection after the timeout expires
				entry.timer = setTimeout(() => {
					if (this._pendingRequests.has(seq)) {
						// Remove the entry so the response (if it ever arrives) is silently ignored
						this._pendingRequests.delete(seq);
						reject(new Error(`Request timed out after ${effectiveTimeout}ms`));
					}
				}, effectiveTimeout);
			}

			// Register the pending entry indexed by sequence number
			this._pendingRequests.set(seq, entry);

			// Asynchronously transmit the message; on send failure, clean up immediately
			this._send(message).catch((_error) => {
				this.debugMessage(`Clearing request due to error: ${seq}`);

				// If the entry is still present (hasn't already timed out or been resolved),
				// cancel its timer and reject the promise with a send-failure error
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
	 *
	 * Opens the underlying WebSocket transport, then immediately sends an `auth`
	 * request as the very first DAP message. If authentication succeeds, fires
	 * `onConnected`. If it fails, closes the transport and throws an
	 * `AuthenticationException` so callers can distinguish auth failures from
	 * network errors.
	 *
	 * The optional `timeout` budget is split: first the WebSocket open consumes
	 * some of it; the remainder is passed as the per-request timeout for the auth
	 * round-trip. This prevents the combined operation from silently hanging
	 * beyond the caller's expectation.
	 *
	 * @param timeout - Optional overall timeout in ms covering both the WebSocket handshake and auth request.
	 * @returns The auth response body (ConnectResult) on success.
	 * @throws AuthenticationException if the server rejects the credentials
	 * @throws Error if the transport is not configured or the connection times out
	 */
	async _dapConnect(timeout?: number): Promise<Record<string, unknown>> {
		// A transport must be bound before this method is called
		if (!this._transport) {
			throw new Error('Transport not configured');
		}

		// Record the wall-clock start time so we can compute the remaining budget
		// after the transport opens (only meaningful when a timeout was provided)
		const start = timeout !== undefined ? Date.now() : 0;

		// Open the underlying WebSocket (or other transport); this may itself honour
		// the timeout when the transport implementation supports it
		await this._transport.connect(timeout);

		// Compute how much of the original budget is left for the auth round-trip
		let authTimeout: number | undefined;
		if (timeout !== undefined) {
			const elapsed = Date.now() - start;
			// Clamp to 0 so we don't pass a negative timeout to request()
			authTimeout = Math.max(timeout - elapsed, 0);
		}

		// Build and send the auth request as the very first DAP message on this connection.
		// The server expects `auth` to be the first command; any other command before auth
		// will be rejected. Include display name and version so operators can identify clients.
		const auth = this._transport.getAuth() ?? '';
		const authArgs: Record<string, unknown> = { auth };
		if (this._clientDisplayName) authArgs.clientName = this._clientDisplayName;
		if (this._clientDisplayVersion) authArgs.clientVersion = this._clientDisplayVersion;
		const resp = await this.request(
			{
				type: 'request',
				command: 'auth',
				seq: 0, // request() overwrites with next seq
				arguments: authArgs,
			},
			authTimeout
		);

		// Check the server's verdict: success=false means wrong credentials or expired token
		const success = (resp as { success?: boolean }).success;
		if (!success) {
			// Close the transport immediately — no further messages are meaningful
			await this._transport.disconnect(resp.message ?? 'Authentication failed', true);
			// Throw a typed exception so callers can catch auth failures separately
			throw new AuthenticationException(resp as unknown as Record<string, unknown>);
		}

		// Auth passed — now notify the rest of the stack that we are connected.
		// We defer this call until after auth because the transport fires its own
		// "connected" signal on socket open, but the logical connection (auth confirmed)
		// only exists once the server acknowledges the credentials.
		const connectionInfo = this._transport.getConnectionInfo();
		await this.onConnected(connectionInfo);

		// Return the body of the auth response (contains ConnectResult: user info, orgs, etc.)
		return resp.body ?? {};
	}

	/**
	 * Close connection to the DAP server and clean up resources.
	 *
	 * Delegates to the transport's `disconnect` method which closes the
	 * underlying socket and triggers `onDisconnected` via the transport callback.
	 */
	async disconnect(): Promise<void> {
		// Request the transport to close the connection gracefully
		if (this._transport) {
			await this._transport.disconnect();
		}
	}

	/**
	 * Check if connected to server.
	 *
	 * Delegates to the transport's connection state; returns false when no
	 * transport is present or the socket is not in the OPEN state.
	 */
	isConnected(): boolean {
		return this._transport?.isConnected() || false;
	}
}
