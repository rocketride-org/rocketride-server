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

import { TransportWebSocket } from './core/TransportWebSocket.js';
import { DAPClient } from './core/DAPClient.js';
import { DAPMessage, EventCallback, RocketRideClientConfig, ConnectCallback, DisconnectCallback, ConnectErrorCallback, ConnectResult, ServerInfoResult, TraceType } from './types/index.js';
import { TASK_STATUS, UPLOAD_RESULT, PIPELINE_RESULT, PipelineConfig, DashboardResponse, ServicesResponse, ServiceDefinition, ValidationResult, CProfileStatusResponse, CProfileStopResponse, CProfileReportResponse, CProfileReportTreeResponse } from './types/index.js';
import { CONST_DEFAULT_WEB_CLOUD, CONST_DEFAULT_WEB_PROTOCOL, CONST_DEFAULT_WEB_PORT } from './constants.js';
import { Question } from './schema/Question.js';
import { AccountApi } from './account.js';
import { BillingApi } from './billing.js';
import { DatabaseApi } from './database.js';
import { DeployApi } from './deploy.js';
import { AuthenticationException, ConnectionException, PipeException } from './exceptions/index.js';

// Global counter for generating unique client IDs
let clientId = 0;

/**
 * Streaming data pipe for sending large datasets to RocketRide pipelines.
 *
 * DataPipe provides a stream-like interface for uploading data to an RocketRide
 * pipeline. It handles the low-level protocol details of opening, writing to,
 * and closing data pipes on the server.
 *
 * Usage pattern:
 * 1. Create pipe using client.pipe()
 * 2. Call open() to establish the pipe
 * 3. Call write() multiple times with data chunks
 * 4. Call close() to finalize and get results
 *
 * @example
 * ```typescript
 * const pipe = await client.pipe(token, { filename: 'data.json' }, 'application/json');
 * await pipe.open();
 * await pipe.write(new TextEncoder().encode('{"data": "value"}'));
 * const result = await pipe.close();
 * ```
 */
export class DataPipe {
	private _client: RocketRideClient;
	private _token: string;
	private _objinfo: Record<string, unknown>;
	private _mimeType: string;
	private _provider?: string;
	private _pipeId?: number;
	private _opened = false;
	private _closed = false;
	private _onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>;

	/**
	 * Creates a new DataPipe instance.
	 *
	 * @param client - The RocketRideClient instance managing this pipe
	 * @param token - Task token for the pipeline receiving the data
	 * @param objinfo - Metadata about the object being sent (e.g., filename, size)
	 * @param mimeType - MIME type of the data being sent (default: 'application/octet-stream')
	 * @param provider - Optional provider name for the data source
	 * @param onSSE - Optional async callback invoked for each SSE event emitted by
	 *                the pipeline node for this specific pipe
	 */
	constructor(client: RocketRideClient, token: string, objinfo: Record<string, unknown> = {}, mimeType = 'application/octet-stream', provider?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>) {
		this._client = client;
		this._token = token;
		this._objinfo = objinfo;
		this._mimeType = mimeType;
		this._provider = provider;
		this._onSSE = onSSE;
	}

	/**
	 * Check if the pipe is currently open for writing.
	 *
	 * @returns true if the pipe has been opened and not yet closed
	 */
	get isOpened(): boolean {
		return this._opened;
	}

	/**
	 * Get the unique ID assigned to this pipe by the server.
	 *
	 * This ID is assigned when the pipe is opened and is used for subsequent
	 * write operations. It remains undefined until open() is called successfully.
	 *
	 * @returns The server-assigned pipe ID, or undefined if not yet opened
	 */
	get pipeId(): number | undefined {
		return this._pipeId;
	}

	/**
	 * Open the pipe for data transmission.
	 *
	 * Establishes a data pipe on the server for streaming data to the pipeline.
	 * Must be called before any write() operations. The server will assign a
	 * unique pipe ID that is used for subsequent operations.
	 *
	 * @returns This DataPipe instance (for method chaining)
	 * @throws Error if the pipe is already opened
	 * @throws PipeException if the server rejects the open request
	 */
	async open(): Promise<DataPipe> {
		if (this._opened) {
			throw new Error('Pipe already opened');
		}

		const request = this._client.buildRequest('rrext_process', {
			arguments: {
				subcommand: 'open',
				object: this._objinfo,
				mimeType: this._mimeType,
				provider: this._provider,
			},
			token: this._token,
		});

		const response = await this._client.request(request);

		if (this._client.didFail(response)) {
			const base = response.message || 'Failed to open a data pipe.';
			const msg = `${base}\n\n` + 'Common causes:\n' + "- Pipeline isn't running (wrong token or task terminated)\n" + '- Pipeline source must be chat, webhook, or dropper\n' + "- MIME type doesn't match the source lane (try mimeType='text/plain')\n";
			throw new PipeException({ ...response, message: msg });
		}

		this._pipeId = response.body?.pipe_id as number | undefined;

		// If an SSE callback was provided, subscribe and register for this pipe
		if (this._onSSE !== undefined && this._pipeId !== undefined) {
			try {
				await this._client.setEvents(this._token, ['SSE'], this._pipeId);
			} catch (err) {
				// Roll back: don't leave the pipe half-open on the server.
				try {
					await this.close();
				} catch {
					// Best-effort cleanup
				}
				const errMsg = err instanceof Error ? err.message : String(err);
				const msg = `Failed to subscribe to SSE events for this data pipe.\n\n${errMsg}`;
				throw new PipeException({ message: msg });
			}

			this._client._ssePipeCallbacks.set(this._pipeId, this._onSSE);
		}

		// Only mark opened after the server-side pipe is fully consistent (including SSE setup).
		this._opened = true;

		return this;
	}

	/**
	 * Write data to the pipe.
	 *
	 * Sends a chunk of data through the pipe to the server pipeline. Can be called
	 * multiple times to stream large datasets. The pipe must be opened first.
	 *
	 * @param buffer - Data to write, must be a Uint8Array
	 * @throws Error if the pipe is not opened or buffer is invalid
	 * @throws PipeException if the server reports a write failure
	 */
	async write(buffer: Uint8Array): Promise<void> {
		if (!this._opened) {
			throw new Error('Pipe not opened');
		}

		if (!(buffer instanceof Uint8Array)) {
			throw new Error('Buffer must be Uint8Array');
		}

		const request = this._client.buildRequest('rrext_process', {
			arguments: {
				subcommand: 'write',
				pipe_id: this._pipeId,
				data: buffer,
			},
			token: this._token,
		});

		const response = await this._client.request(request);

		if (this._client.didFail(response)) {
			const msg = response.message || 'Failed to write to a data pipe.';
			throw new PipeException({ ...response, message: msg });
		}
	}

	/**
	 * Close the pipe and get the processing results.
	 *
	 * Finalizes the data stream and signals the server that no more data will be sent.
	 * The server processes any buffered data and returns the final result. After closing,
	 * the pipe cannot be reopened or written to again.
	 *
	 * @returns The processing result from the server, or undefined if already closed
	 * @throws PipeException if the server reports a failure while finalizing the pipe
	 */
	async close(): Promise<PIPELINE_RESULT | undefined> {
		// Allow closing after a failed open() path where the server assigned a pipe_id
		// but we never flipped _opened=true (e.g., SSE subscription failure).
		if (this._closed || (this._pipeId === undefined && !this._opened)) {
			return;
		}

		try {
			const request = this._client.buildRequest('rrext_process', {
				arguments: {
					subcommand: 'close',
					pipe_id: this._pipeId,
				},
				token: this._token,
			});

			const response = await this._client.request(request);

			if (this._client.didFail(response)) {
				const msg = response.message || 'Failed to close a data pipe.';
				throw new PipeException({ ...response, message: msg });
			}

			return response.body as PIPELINE_RESULT;
		} finally {
			this._closed = true;
			this._opened = false;

			// Unregister SSE callback and scoped monitor subscription
			if (this._onSSE !== undefined && this._pipeId !== undefined) {
				this._client._ssePipeCallbacks.delete(this._pipeId);
				try {
					await this._client.setEvents(this._token, [], this._pipeId);
				} catch {
					// Best-effort cleanup
				}
			}
		}
	}

	/**
	 * Invoke a @tool_function on a pipeline node using this pipe.
	 *
	 * The call reuses this pipe's existing pipeline instance, avoiding the
	 * overhead of borrowing a new one from the pool.
	 *
	 * @param tool - Name of the @tool_function to invoke
	 * @param nodeId - Target node ID.  When empty the call broadcasts to all
	 *                 tool-lane nodes; the first node that owns the tool handles it.
	 * @param input - Arguments forwarded to the tool function
	 * @returns The tool's return value (typically a record/object)
	 * @throws Error if the pipe is not open or no node handles the tool
	 */
	async tool<T = any>(tool: string, nodeId = '', input: Record<string, unknown> = {}): Promise<T> {
		if (!this._opened) {
			throw new Error('Pipe is not open');
		}

		const request = this._client.buildRequest('rrext_process', {
			arguments: {
				subcommand: 'tool',
				tool,
				nodeId,
				input,
				pipe_id: this._pipeId,
			},
			token: this._token,
		});

		const response = await this._client.request(request);

		if (this._client.didFail(response)) {
			const msg = response.message || `Tool "${tool}" invocation failed.`;
			throw new Error(msg);
		}

		return (response.body as any)?.result as T;
	}
}

/**
 * Main RocketRide client for connecting to RocketRide servers and services.
 *
 * This client provides a comprehensive API for interacting with RocketRide services,
 * including connection management, pipeline execution, data operations, AI chat,
 * event handling, and server connectivity testing.
 *
 * Key features:
 * - Single shared WebSocket connection for all operations
 * - Connection management (connect/disconnect) with optional persistence
 * - Automatic reconnection when persist mode is enabled
 * - Pipeline execution (use, terminate, getTaskStatus)
 * - Data operations (send, sendFiles, pipe)
 * - AI chat functionality (chat)
 * - Event handling (setEvents, event callbacks)
 * - Server connectivity testing (ping)
 * - Full TypeScript type safety
 */

// =============================================================================
// MONITOR TYPES
// =============================================================================

/**
 * Identifies a monitor subscription key.
 *
 * - `{ token }` — monitors a specific running task by its session token.
 * - `{ projectId, source }` — monitors a project/source regardless of task.
 */
export type MonitorKey = { token: string } | { projectId: string; source: string; pipeId?: number };

export class RocketRideClient extends DAPClient {
	private _uri!: string;
	private _apikey?: string;
	private _wsPath?: string;
	private _env: Record<string, string>;
	private _callerOnEvent?: EventCallback;
	private _callerOnConnected?: ConnectCallback;
	private _callerOnDisconnected?: DisconnectCallback;
	private _callerOnConnectError?: ConnectErrorCallback;
	private _dapAttempted = false;
	private _dapSend?: (event: unknown) => void;
	private _nextChatId = 1;
	/** Maps pipe_id → SSE callback for pipe-scoped real-time event dispatch. */
	readonly _ssePipeCallbacks = new Map<number, (type: string, data: Record<string, unknown>) => Promise<void>>();

	// Desired state model — replaces old flag soup
	private _desiredState: 'detached' | 'attached' | 'authenticated' = 'detached';
	private _authenticated: boolean = false;
	private _persist: boolean = false;
	private _reconnectTimer?: ReturnType<typeof setTimeout>;
	private _currentReconnectDelay: number = 250;

	/** Reference-counted monitor subscriptions: keyString → Map<eventType, refCount> */
	private _monitorKeys = new Map<string, Map<string, number>>();

	/** Lazily-created account API namespace. */
	private _account?: AccountApi;

	/** Lazily-created billing API namespace. */
	private _billing?: BillingApi;

	/** Lazily-created database API namespace. */
	private _database?: DatabaseApi;

	/** Lazily-created deploy API namespace. */
	private _deploy?: DeployApi;

	/** Optional trace callback for observing all call() traffic. */
	private _onTrace?: (traceType: TraceType, message: DAPMessage) => void;

	/**
	 * Creates a new RocketRideClient instance.
	 *
	 * Configuration priority (highest to lowest):
	 * 1. Values passed in config parameter (auth, uri)
	 * 2. Values from env parameter (if provided)
	 * 3. Values from .env file (Node.js only)
	 * 4. Default values
	 *
	 * @param config - Configuration options for the client
	 * @param config.auth - API key for authentication (required)
	 * @param config.uri - Server URI (default: CONST_DEFAULT_SERVICE)
	 * @param config.env - Environment variables dictionary for configuration and substitution
	 * @param config.onEvent - Callback for server events
	 * @param config.onConnected - Callback when connection is established
	 * @param config.onDisconnected - Callback when connection is lost
	 * @param config.persist - Enable automatic reconnection
	 * @param config.requestTimeout - Default timeout in ms for individual requests
	 * @param config.maxRetryTime - Max total time in ms to keep retrying connections
	 * @param config.module - Optional module name for client identification
	 *
	 * @throws Error if auth is not provided via config, env, or .env file
	 *
	 * @example
	 * ```typescript
	 * // Using explicit auth and URI
	 * const client = new RocketRideClient({
	 *   auth: 'your-api-key',
	 *   uri: 'wss://your-server.com',
	 *   persist: true,
	 *   onEvent: (event) => console.log('Event:', event)
	 * });
	 *
	 * // Using custom env dictionary
	 * const client = new RocketRideClient({
	 *   env: {
	 *     ROCKETRIDE_APIKEY: 'your-api-key',
	 *     ROCKETRIDE_URI: 'wss://your-server.com',
	 *     ROCKETRIDE_PROJECT_ID: 'my-project'
	 *   }
	 * });
	 * ```
	 */
	constructor(config: RocketRideClientConfig = {}) {
		// Check if we're in Node.js or browser environment
		const isBrowser = typeof window !== 'undefined';

		// Build environment variables dictionary
		// Priority: provided env > process.env (Node.js only)
		let clientEnv: Record<string, string> = {};

		if (config.env) {
			// Use provided env dictionary
			clientEnv = { ...config.env };
		} else if (!isBrowser && typeof process !== 'undefined' && process.env) {
			// In Node.js, copy process.env values that are strings
			for (const [key, value] of Object.entries(process.env)) {
				if (typeof value === 'string') {
					clientEnv[key] = value;
				}
			}
		}

		const { auth = config.auth, uri = config.uri || clientEnv.ROCKETRIDE_URI || CONST_DEFAULT_WEB_CLOUD, onEvent, onConnected, onDisconnected, onConnectError, persist, module } = config;

		// Create unique client identifier
		const clientName = module || `CLIENT-${clientId++}`;

		// Initialize the DAPClient without a transport; transport is created in _internalAttach
		super(clientName, undefined, config);

		// Store connection details and environment
		this._wsPath = config.wsPath;
		this._setUri(uri);
		this._setAuth(auth ?? '');
		this._env = clientEnv;

		// Set up callbacks if provided
		if (onEvent) this._callerOnEvent = onEvent;
		if (onConnected) this._callerOnConnected = onConnected;
		if (onDisconnected) this._callerOnDisconnected = onDisconnected;
		if (onConnectError) this._callerOnConnectError = onConnectError;
		if (config.onTrace) this._onTrace = config.onTrace;

		// Set up persistence options
		this._persist = persist ?? false;
		// maxRetryTime accepted for backward compat but ignored (linear backoff never gives up)
	}

	/**
	 * Normalize a user-provided URI into a fully-formed HTTP/HTTPS URL.
	 *
	 * - Bare hostnames (e.g. "localhost", "my-server:5565") get `http://` prepended.
	 * - Non-cloud URIs without a port default to 5565.
	 *
	 * Use this when you need a parseable URL from free-form user input before
	 * passing it to the client or doing your own validation.
	 */
	public static normalizeUri(uri: string): string {
		let normalized = uri.trim();
		if (normalized && !/^[a-zA-Z]+:\/\//.test(normalized)) {
			normalized = `${CONST_DEFAULT_WEB_PROTOCOL}${normalized}`;
		}

		try {
			const url = new URL(normalized);

			// The URL API silently strips ports that are default-for-scheme
			// (e.g. :443 on https, :80 on http), so url.port alone cannot
			// distinguish "no port given" from "scheme-default port given".
			// Check the raw input for an explicit `:digits` after the scheme.
			const withoutScheme = normalized.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//, '');
			const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
			const hasExplicitPort = authority.startsWith('[')
				? /\]:\d+$/.test(authority) // IPv6 literal with explicit port
				: /:\d+$/.test(authority); // hostname/IPv4 with explicit port

			if (!url.port && !hasExplicitPort && !url.hostname.includes('rocketride.ai')) {
				url.port = CONST_DEFAULT_WEB_PORT;
			}

			return `${url.protocol}//${url.host}`;
		} catch {
			return normalized;
		}
	}

	/**
	 * Probe a server for its capabilities without authenticating.
	 *
	 * Creates a temporary public connection and sends an
	 * ``rrext_public_probe`` command. The server responds with version,
	 * capabilities, platform, and public apps without requiring credentials.
	 *
	 * @param uri - Server URI (e.g. ``"localhost:5565"``, ``"https://api.rocketride.ai"``)
	 * @param timeout - Optional timeout in ms for the entire operation
	 * @returns Server info including version and capability tags
	 * @throws Error if the server is unreachable or does not support probes
	 *
	 * @example
	 * ```typescript
	 * const info = await RocketRideClient.getServerInfo('localhost:5565');
	 * if (info.capabilities.includes('saas')) {
	 *   // Show cloud sign-in options
	 * }
	 * ```
	 */
	public static async getServerInfo(uri: string, timeout?: number): Promise<ServerInfoResult> {
		const client = new RocketRideClient({ uri, persist: false });
		try {
			// Open a public connection (no auth handshake)
			await client.attach(uri, { timeout });

			// Send rrext_public_probe — allowed on unauthenticated connections
			const message = client.buildRequest('rrext_public_probe', {});
			const response = await client.request(message, timeout);

			if (response.success === false) {
				throw new Error(response.message || 'Server info request failed');
			}

			return (response.body ?? {}) as unknown as ServerInfoResult;
		} finally {
			await client.disconnect();
		}
	}

	/**
	 * Normalize a user-provided URI into a fully-formed WebSocket address.
	 * Builds on normalizeUri, then converts to ws/wss and appends /task/service.
	 */
	private _getWebsocketUri(uri: string): string {
		const httpUrl = RocketRideClient.normalizeUri(uri);
		const path = this._wsPath ?? '/task/service';

		try {
			const url = new URL(httpUrl);
			const wsScheme = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
			return `${wsScheme}//${url.host}${path}`;
		} catch {
			return `${httpUrl}${path}`;
		}
	}

	/**
	 * Update the server URI (internal).
	 */
	private _setUri(uri: string): void {
		this._uri = this._getWebsocketUri(uri);
	}

	/**
	 * Update the authentication credential (internal).
	 */
	private _setAuth(auth: string): void {
		this._apikey = auth;
	}

	// ============================================================================
	// INTERNAL CONNECTION HELPERS
	// ============================================================================

	/**
	 * Create transport if needed and open the WebSocket. No auth.
	 */
	private async _internalAttach(timeout?: number): Promise<void> {
		if (!this._transport) {
			const transport = new TransportWebSocket(this._uri);
			this._bindTransport(transport);
		}
		await super._dapConnect(timeout);
	}

	/**
	 * Send the ``auth`` DAP command over the open transport.
	 * Sets ``_authenticated`` and ``_connectResult`` on success.
	 * Throws ``AuthenticationException`` on failure (transport stays open).
	 */
	private async _internalLogin(timeout?: number): Promise<ConnectResult> {
		// Build auth args with credential + client identification
		const authArgs: Record<string, unknown> = { auth: this._apikey ?? '' };
		if (this._clientDisplayName) authArgs.clientName = this._clientDisplayName;
		if (this._clientDisplayVersion) authArgs.clientVersion = this._clientDisplayVersion;

		const resp = await this.request(
			{ type: 'request', command: 'auth', seq: 0, arguments: authArgs },
			timeout,
		);

		const success = (resp as { success?: boolean }).success;
		if (!success) {
			throw new AuthenticationException(resp as unknown as Record<string, unknown>);
		}

		this._connectResult = resp.body as unknown as ConnectResult;
		this._authenticated = true;

		// Store userToken for future reconnects
		if (this._connectResult?.userToken) {
			this._apikey = this._connectResult.userToken;
		}

		// Resubscribe monitors and notify
		await this._resubscribeAllMonitors();
		const connectionInfo = this._transport?.getConnectionInfo() ?? '';
		if (this._callerOnConnected) {
			try { await this._callerOnConnected(connectionInfo); }
			catch (e) { this.debugMessage(`Error in user onConnected handler: ${e}`); }
		}
		await super.onConnected(connectionInfo);

		return this._connectResult;
	}

	/**
	 * Send the ``deauth`` DAP command to revert to unauthenticated.
	 */
	private async _internalLogout(): Promise<void> {
		if (!this._authenticated || !this._transport?.isConnected()) return;
		try {
			await this.request({ type: 'request', command: 'deauth', seq: 0, arguments: {} });
		} catch {
			// Best-effort — server may have already disconnected
		}
		this._connectResult = undefined;
		this._authenticated = false;
	}

	/**
	 * Close the transport. Triggers onDisconnected via the transport callback.
	 */
	private async _internalDisconnect(): Promise<void> {
		if (!this._transport) return;
		await this._transport.disconnect();
	}

	/**
	 * Clear the reconnect timer if active.
	 */
	private _clearReconnectTimer(): void {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
	}

	/**
	 * Reconnect engine driven by ``_desiredState``.
	 *
	 * Schedules a timer that re-attaches (and re-logins if the user had
	 * been authenticated). Checks ``_desiredState`` after every await so
	 * user actions mid-reconnect are respected immediately.
	 *
	 * Linear backoff: 250ms → 500ms → ... → 15 000ms cap.
	 */
	private _scheduleReconnect(): void {
		this.debugMessage(`Scheduling reconnect in ${this._currentReconnectDelay}ms`);
		this._reconnectTimer = setTimeout(async () => {
			try {
				// Re-attach transport
				await this._internalAttach();
				if (this._desiredState === 'detached') { this._reconnectTimer = undefined; return; }

				// Re-login if the user was authenticated
				if (this._desiredState === 'authenticated') {
					await this._internalLogin();
					if ((this._desiredState as string) === 'detached') { this._reconnectTimer = undefined; return; }
				}

				// Success — reset backoff
				this._reconnectTimer = undefined;
				this._currentReconnectDelay = 250;
				this.debugMessage('Reconnect successful');
			} catch (err) {
				// User changed intent — stop (desiredState may have been changed by detach() during await)
				if ((this._desiredState as string) === 'detached') { this._reconnectTimer = undefined; return; }

				// Auth rejected — downgrade to attached, stop retrying auth
				if (err instanceof AuthenticationException) {
					this._desiredState = 'attached';
					this._reconnectTimer = undefined;
					await this.onConnectError(err as Error);
					return;
				}

				// Transient failure — linear backoff, cap at 15s
				this._currentReconnectDelay = Math.min(this._currentReconnectDelay + 250, 15000);
				const error = err instanceof Error ? err : new Error(String(err));
				await this.onConnectError(error);
				this._scheduleReconnect(); // replaces timer with new delay
			}
		}, this._currentReconnectDelay);
	}

	// ============================================================================
	// PUBLIC API — TRANSPORT
	// ============================================================================

	/**
	 * Attach to a RocketRide server (open WebSocket, no auth).
	 *
	 * If ``uri`` is provided and differs from the current URI, detaches
	 * first. If already attached to the same URI, this is a no-op.
	 *
	 * After attach, public APIs (``rrext_public_*``) are available.
	 *
	 * @param uri - Server URI override. Updates the stored URI if provided.
	 * @param options - Optional timeout for the WebSocket handshake.
	 */
	async attach(uri?: string, options?: { timeout?: number }): Promise<void> {
		// URI change → detach first, then update
		if (uri) {
			const normalised = this._getWebsocketUri(uri);
			if (normalised !== this._uri) {
				if (this.isAttached()) await this.detach();
				this._setUri(uri);
			}
		}
		// Already attached → no-op
		if (this.isAttached()) {
			this._desiredState = this._desiredState === 'detached' ? 'attached' : this._desiredState;
			return;
		}
		this._desiredState = 'attached';
		await this._internalAttach(options?.timeout);
	}

	/**
	 * Detach from the server (close WebSocket, cancel reconnection).
	 *
	 * Sets ``_desiredState`` to ``'detached'`` so the reconnect engine
	 * stops and ``onDisconnected`` does not restart it.
	 */
	async detach(): Promise<void> {
		this._desiredState = 'detached';
		this._clearReconnectTimer();
		this._authenticated = false;
		this._connectResult = undefined;
		if (this._transport?.isConnected()) {
			await this._internalDisconnect();
		}
	}

	/**
	 * True when the WebSocket transport is connected (regardless of auth).
	 */
	isAttached(): boolean {
		return this._transport?.isConnected() || false;
	}

	// ============================================================================
	// PUBLIC API — AUTH
	// ============================================================================

	/**
	 * Authenticate over an attached transport.
	 *
	 * If ``uri`` is provided and differs, detaches and re-attaches first.
	 * If ``auth`` is provided and differs from the current credential,
	 * logs out (best-effort) before logging in with the new credential.
	 * If already authenticated with the same credential, this is a no-op.
	 *
	 * @param credential - API key, rr_ token, or PKCE code object.
	 * @param options - Optional URI override and/or timeout.
	 * @returns ConnectResult with user identity on success.
	 * @throws AuthenticationException on auth failure (transport stays attached).
	 */
	async login(
		credential?: string | { code: string; verifier: string; redirectUri: string },
		options?: { uri?: string; timeout?: number },
	): Promise<ConnectResult> {
		// Resolve credential
		let resolvedCredential: string;
		if (credential && typeof credential === 'object') {
			resolvedCredential = 'cd_' + btoa(JSON.stringify(credential));
		} else {
			const envKey = this._env['ROCKETRIDE_APIKEY'];
			const envCredential = typeof envKey === 'string' && envKey.trim() !== '' ? envKey : undefined;
			resolvedCredential = (credential as string | undefined) ?? envCredential ?? this._apikey ?? '';
		}

		// URI change → detach + re-attach
		if (options?.uri) {
			const normalised = this._getWebsocketUri(options.uri);
			if (normalised !== this._uri) {
				await this.detach();
				this._setUri(options.uri);
				await this._internalAttach(options.timeout);
			}
		}

		// Ensure attached
		if (!this.isAttached()) {
			await this._internalAttach(options?.timeout);
		}

		// Auth change → logout first (best-effort)
		if (resolvedCredential !== this._apikey && this._authenticated) {
			try { await this._internalLogout(); } catch {}
		}
		this._setAuth(resolvedCredential);

		// Already authenticated with same credential → no-op
		if (this._authenticated) {
			this._desiredState = 'authenticated';
			return this._connectResult ?? ({} as ConnectResult);
		}

		this._desiredState = 'authenticated';
		return this._internalLogin(options?.timeout);
	}

	/**
	 * Deauthenticate: sends ``deauth`` to the server, clears client auth state.
	 * The transport stays attached — public APIs continue to work.
	 */
	async logout(): Promise<void> {
		await this._internalLogout();
		this._desiredState = 'attached';
	}

	/**
	 * True when the auth handshake has succeeded on the current connection.
	 */
	isAuthenticated(): boolean {
		return this._authenticated;
	}

	// ============================================================================
	// COMPAT API — connect() / disconnect()
	// ============================================================================

	/**
	 * Check if the client is currently connected to the RocketRide server.
	 * Equivalent to ``isAttached()`` — kept for backward compatibility.
	 */
	isConnected(): boolean {
		return this.isAttached();
	}

	/**
	 * Connect to the RocketRide server and authenticate in a single call.
	 *
	 * Backward-compatible wrapper around ``attach()`` + ``login()``.
	 * Sends the credential as the first DAP message and returns the full
	 * ConnectResult (user identity + organizations + teams) on success.
	 *
	 * @param credential - API key / Zitadel access_token / rr_ user token / PKCE code object.
	 * @param options - Optional overrides: uri and/or timeout.
	 */
	async connect(credential?: string | { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult> {
		this._currentReconnectDelay = 250;
		await this.attach(options?.uri, { timeout: options?.timeout });
		return this.login(credential, options);
	}

	/**
	 * Get the ConnectResult from the last successful connect().
	 * Returns undefined if not connected or not yet authenticated.
	 */
	getAccountInfo(): ConnectResult | undefined {
		return this._connectResult;
	}

	/**
	 * Returns the ID of the user's organization.
	 */
	getOrgId(): string | undefined {
		return this._connectResult?.organization?.id;
	}

	/**
	 * Disconnect from the RocketRide server and stop automatic reconnection.
	 * Backward-compatible wrapper around ``logout()`` + ``detach()``.
	 */
	async disconnect(): Promise<void> {
		await this.logout();
		await this.detach();
	}

	/**
	 * Update the environment variables used for pipeline substitution.
	 *
	 * The env dictionary is used by {@link use} and {@link validate} to replace
	// ============================================================================
	// PING METHODS
	// ============================================================================

	/**
	 * Test connectivity to the RocketRide server.
	 *
	 * Sends a lightweight ping request to the server to verify it's responding
	 * and reachable. This is useful for connectivity testing, health checks,
	 * and measuring response times.
	 */
	async ping(token?: string): Promise<void> {
		try {
			await this.call('rrext_ping', undefined, { token });
		} catch (err) {
			throw new Error(`Ping failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	// ============================================================================
	// EXECUTION METHODS
	// ============================================================================

	/**
	 * Load Node.js fs/promises at runtime without static imports.
	 * This keeps browser bundles free of Node built-ins while preserving Node features.
	 */
	private async _loadNodeFsPromises(): Promise<{
		readFile: (path: string, encoding: string) => Promise<string>;
		stat: (path: string) => Promise<{ size: number }>;
	}> {
		if (typeof window !== 'undefined') {
			throw new Error('Node.js filesystem APIs are not available in browser environment.');
		}

		try {
			const req = (0, eval)('require') as undefined | ((moduleName: string) => any);
			if (typeof req === 'function') {
				const fsPromises = req('fs/promises');
				if (fsPromises) {
					return fsPromises as {
						readFile: (path: string, encoding: string) => Promise<string>;
						stat: (path: string) => Promise<{ size: number }>;
					};
				}
			}
		} catch {
			// Fall through to runtime dynamic import
		}

		// Use Function to avoid bundlers statically resolving Node built-ins.
		const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>;
		const fsPromises = await dynamicImport('fs/promises');
		return fsPromises as {
			readFile: (path: string, encoding: string) => Promise<string>;
			stat: (path: string) => Promise<{ size: number }>;
		};
	}

	// ============================================================================
	// VALIDATION METHODS
	// ============================================================================

	/**
	 * Validate a pipeline configuration.
	 *
	 * Sends the pipeline to the server for structural validation, checking
	 * component compatibility, connection integrity, and the resolved
	 * execution chain.
	 *
	 * Source resolution follows the same logic as {@link use}:
	 * 1. Explicit `source` option (if provided)
	 * 2. `source` field inside the pipeline config
	 * 3. Implied source: the single component whose config.mode is 'Source'
	 *
	 * @param options.pipeline - Pipeline configuration to validate
	 * @param options.source - Optional override for the source component ID
	 * @returns Promise resolving to validation result with errors, warnings,
	 *          resolved component, and execution chain
	 * @throws Error if the server returns a validation error
	 *
	 * @example
	 * ```typescript
	 * const result = await client.validate({
	 *   pipeline: { components: [...], project_id: '123' },
	 *   source: 'webhook_1'
	 * });
	 * if (result.errors?.length) {
	 *   console.log('Validation errors:', result.errors);
	 * }
	 * ```
	 */
	async validate(options: { pipeline: PipelineConfig | Record<string, unknown>; source?: string }): Promise<ValidationResult> {
		const { pipeline, source } = options;
		const args: Record<string, unknown> = { pipeline };
		if (source !== undefined) {
			args.source = source;
		}
		try {
			return await this.call<ValidationResult>('rrext_validate', args);
		} catch (err) {
			throw new Error(`Pipeline validation failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	// ============================================================================
	// PIPELINE EXECUTION METHODS
	// ============================================================================

	/**
	 * Start an RocketRide pipeline for processing data.
	 *
	 * This method loads and executes a pipeline configuration. It automatically performs
	 * environment variable substitution on the pipeline config, replacing ${ROCKETRIDE_*}
	 * placeholders with values from the .env file or the `env` dictionary passed to the constructor.
	 *
	 * When loading from a file via `filepath`, the client automatically unwraps `.pipe` files
	 * that use the `{ "pipeline": { ... } }` wrapper format. If the file contains a top-level
	 * `pipeline` key, the inner object is extracted; otherwise the file content is used as-is.
	 *
	 * When passing a `pipeline` object directly, provide a flat `PipelineConfig` with
	 * `components`, `source`, and `project_id` at the top level — do NOT wrap it in
	 * `{ pipeline: { ... } }`.
	 *
	 * @param options - Pipeline execution options
	 * @param options.token - Custom token for the pipeline (auto-generated if not provided)
	 * @param options.filepath - Path to a `.pipe` or JSON file containing pipeline configuration (Node.js only)
	 * @param options.pipeline - Flat PipelineConfig object (alternative to filepath)
	 * @param options.source - Override pipeline source
	 * @param options.threads - Number of threads for execution (default: 1)
	 * @param options.useExisting - Use existing pipeline instance
	 * @param options.args - Command line arguments to pass to pipeline
	 * @param options.ttl - Time-to-live in seconds for idle pipelines (optional, server default if not provided; use 0 for no timeout)
	 * @param options.pipelineTraceLevel - Trace level: 'none' | 'metadata' | 'summary' | 'full'. When set, captures every lane write and invoke call in the response under '_trace'.
	 *
	 * @returns Promise resolving to an object containing the task token and other metadata
	 * @throws Error if neither pipeline nor filepath is provided
	 *
	 * @example
	 * ```typescript
	 * // Using a .pipe file (wrapper is automatically unwrapped)
	 * const result = await client.use({ filepath: './chat.pipe' });
	 *
	 * // Using a flat pipeline config object
	 * const result = await client.use({
	 *   pipeline: { components: [...], source: 'chat_1', project_id: '...' }
	 * });
	 *
	 * // Reuse an existing pipeline
	 * const result = await client.use({ filepath: './chat.pipe', useExisting: true });
	 * ```
	 */
	async use(
		options: {
			token?: string;
			filepath?: string;
			pipeline?: PipelineConfig;
			source?: string;
			threads?: number;
			useExisting?: boolean;
			args?: string[];
			ttl?: number;
			/** Pipeline trace level. When set, captures every lane write and invoke call in the response under '_trace'. */
			pipelineTraceLevel?: 'none' | 'metadata' | 'summary' | 'full';
			/** Optional display name for the task (e.g. shown in dashboard). */
			name?: string;
			/** ROCKETRIDE_* environment overrides merged on top of server-side env. */
			env?: Record<string, string>;
			/** Team ID to run the task under. Defaults to the user's default team. */
			teamId?: string;
		} = {}
	): Promise<Record<string, unknown> & { token: string }> {
		const { token, filepath, pipeline, source, threads, useExisting, args, ttl, pipelineTraceLevel, name, env, teamId } = options;

		// Validate required parameters
		if (!pipeline && !filepath) {
			throw new Error('Pipeline configuration or file path is required and must be specified');
		}

		let pipelineConfig: PipelineConfig;

		// Load pipeline configuration from file if needed
		if (!pipeline && filepath) {
			// Check if we're in Node.js environment
			if (typeof window !== 'undefined') {
				throw new Error('File loading not available in browser environment. Please provide pipeline object directly.');
			}

			// Load file in Node.js without static fs imports (browser-safe bundle)
			const fsPromises = await this._loadNodeFsPromises();
			const fileContent = await fsPromises.readFile(filepath, 'utf-8');
			const parsed = JSON.parse(fileContent);
			// .pipe files wrap the config in { "pipeline": { ... } } — unwrap if present
			pipelineConfig = parsed.pipeline ?? parsed;
		} else {
			pipelineConfig = pipeline!;
		}

		// Create a deep copy of the pipeline config to avoid modifying the original
		const processedConfig = JSON.parse(JSON.stringify(pipelineConfig));

		// Override source if specified (after substitution)
		if (source !== undefined) {
			processedConfig.source = source;
		}

		// Build execution request with all parameters
		const arguments_: Record<string, unknown> = {
			pipeline: processedConfig,
			args: args || [],
		};

		// Add TTL if provided (server uses its default if not specified)
		if (ttl !== undefined) {
			arguments_.ttl = ttl;
		}

		// Add optional parameters if specified
		if (token !== undefined) {
			arguments_.token = token;
		}
		if (threads !== undefined) {
			arguments_.threads = threads;
		}
		if (useExisting !== undefined) {
			arguments_.useExisting = useExisting;
		}
		if (pipelineTraceLevel !== undefined) {
			arguments_.pipelineTraceLevel = pipelineTraceLevel;
		}
		// Build ROCKETRIDE_* env from client's .env + caller overrides
		const rocketEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(this._env)) {
			if (k.startsWith('ROCKETRIDE_')) rocketEnv[k] = v;
		}
		if (env) Object.assign(rocketEnv, env);
		if (Object.keys(rocketEnv).length > 0) {
			arguments_.env = rocketEnv;
		}
		// Derive display name from filepath if not explicitly provided
		const effectiveName = name ?? (filepath ? filepath.replace(/^.*[\\/]/, '').replace(/\.pipe(?:\.json)?$/, '') : undefined);
		if (effectiveName !== undefined) {
			arguments_.name = effectiveName;
		}
		if (teamId !== undefined) {
			arguments_.teamId = teamId;
		}

		// Send execution request to server
		try {
			const body = await this.call('execute', arguments_);

			// Extract and validate response
			const responseBody = body || {};
			const taskToken = responseBody.token as string;

			if (!taskToken) {
				throw new Error('Server did not return a task token in successful response');
			}

			this.debugMessage(`Pipeline execution started successfully, task token: ${taskToken}`);

			// Type assertion to ensure token is present
			return responseBody as Record<string, unknown> & { token: string };
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.debugMessage(`Pipeline execution failed: ${errorMsg}`);
			throw err;
		}
	}

	/**
	 * Terminate a running pipeline.
	 */
	async terminate(token: string): Promise<void> {
		try {
			await this.call('terminate', undefined, { token });
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.debugMessage(`Pipeline termination failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}
	}

	/**
	 * Restart a running pipeline with a new configuration.
	 *
	 * Looks up the existing task by project/source, terminates it, and
	 * starts a new execution in one server round-trip.
	 *
	 * @param options.token - Existing task token (optional, resolved server-side if omitted).
	 * @param options.projectId - The project identifier.
	 * @param options.source - The source component identifier.
	 * @param options.pipeline - The pipeline configuration to restart with.
	 */
	async restart(options: { token?: string; projectId: string; source: string; pipeline: Record<string, unknown> }): Promise<void> {
		try {
			await this.call(
				'restart',
				{
					token: options.token,
					projectId: options.projectId,
					source: options.source,
					pipeline: options.pipeline,
				},
			);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.debugMessage(`Pipeline restart failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}
	}

	/**
	 * Get the current status of a running pipeline.
	 *
	 * By default this call is bounded to 15s so callers/tests don't hang forever if the engine
	 * stops responding mid-request (especially important in CI). Pass `{ timeout: false }` to
	 * restore the previous behavior of using only the client-level request timeout (if any).
	 */
	async getTaskStatus(token: string, options?: { timeout?: number | false }): Promise<TASK_STATUS> {
		try {
			const callOptions: { token: string; timeout?: number } = { token };
			if (options?.timeout === false) {
				// Intentionally omit per-call timeout override.
			} else {
				callOptions.timeout = options?.timeout ?? 15000;
			}
			return await this.call<TASK_STATUS>('rrext_get_task_status', undefined, callOptions);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.debugMessage(`Pipeline status retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}
	}

	/**
	 * Resolve a running task's token from its project ID and source component.
	 *
	 * The token is required for operations like terminate and restart.
	 * Returns undefined if no task is currently running for the given project/source.
	 *
	 * @param options.projectId - The project identifier.
	 * @param options.source - The source component identifier.
	 */
	async getTaskToken(options: { projectId: string; source: string }): Promise<string | undefined> {
		const body = await this.call('rrext_get_token', {
			projectId: options.projectId,
			source: options.source,
		});
		return body?.token as string | undefined;
	}

	/**
	 * Returns the unresolved pipeline for a running task.
	 *
	 * The pipeline is returned exactly as stored — ${ROCKETRIDE_*} placeholders are
	 * NOT substituted, so no secrets are included in the response.
	 *
	 * @param token - Task token returned by {@link getTaskToken}.
	 * @returns The unresolved pipeline dict, or undefined if the task is not found.
	 */
	async getTaskPipeline(token: string): Promise<Record<string, unknown> | undefined> {
		const body = await this.call('rrext_get_pipeline', undefined, { token });
		return body?.pipeline as Record<string, unknown> | undefined;
	}

	// ============================================================================
	// DATA METHODS
	// ============================================================================

	/** Return objinfo with size set; never 0 (parse filter skips "empty"). */
	private _objinfoWithSize(objinfo: Record<string, unknown>, size: number): Record<string, unknown> {
		return { ...objinfo, size: size || 1 };
	}

	/**
	 * Create a data pipe for streaming operations.
	 */
	async pipe(token: string, objinfo: Record<string, unknown> = {}, mimeType?: string, provider?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>): Promise<DataPipe> {
		return new DataPipe(this, token, objinfo, mimeType, provider, onSSE);
	}

	/**
	 * Send data to a running pipeline.
	 */
	async send(token: string, data: string | Uint8Array, objinfo: Record<string, unknown> = {}, mimetype?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>): Promise<PIPELINE_RESULT | undefined> {
		// Convert string to bytes if needed
		let buffer: Uint8Array;
		if (typeof data === 'string') {
			buffer = new TextEncoder().encode(data);
		} else if (data instanceof Uint8Array) {
			buffer = data;
		} else {
			throw new Error('data must be either a string or Uint8Array');
		}

		// Create and use a temporary pipe for the data
		const pipe = await this.pipe(token, this._objinfoWithSize(objinfo, buffer.length), mimetype, undefined, onSSE);

		try {
			await pipe.open();
			await pipe.write(buffer);
			return await pipe.close();
		} catch (error) {
			// Clean up pipe on any error
			if (pipe.isOpened) {
				try {
					await pipe.close();
				} catch {
					// Ignore cleanup errors
				}
			}
			throw error;
		}
	}

	/**
	 * Upload multiple files to a pipeline with progress tracking and parallel execution.
	 *
	 * This method efficiently uploads files in parallel with configurable concurrency control.
	 * Each file is streamed through a data pipe, and progress events are emitted through the
	 * event system for all subscribers. The order of results matches the input file order.
	 *
	 * Progress events are sent through the event system as 'apaevt_status_upload' events
	 * (matching Python client behavior) rather than through a callback parameter.
	 *
	 * @param files - Array of file objects with optional metadata and MIME types
	 * @param token - Pipeline task token to receive the uploads
	 * @param maxConcurrent - Maximum number of concurrent uploads (default: 5)
	 *
	 * @returns Promise resolving to array of UPLOAD_RESULT objects in the same order as input
	 *
	 * @example
	 * ```typescript
	 * // Subscribe to upload events
	 * client.on('apaevt_status_upload', (event) => {
	 *   console.log(`${event.body.filepath}: ${event.body.bytes_sent}/${event.body.file_size}`);
	 * });
	 *
	 * // Upload files
	 * const results = await client.sendFiles(
	 *   [
	 *     { file: fileObject1 },
	 *     { file: fileObject2, mimetype: 'application/json' },
	 *     { file: fileObject3, objinfo: { custom: 'metadata' } }
	 *   ],
	 *   'task-token',
	 *   10  // Upload max 10 files concurrently
	 * );
	 * ```
	 */
	async sendFiles(
		files: Array<{
			file: File;
			objinfo?: Record<string, unknown>;
			mimetype?: string;
		}>,
		token: string
	): Promise<UPLOAD_RESULT[]> {
		const results: UPLOAD_RESULT[] = new Array(files.length);

		/**
		 * Helper function to send upload events through the event system.
		 */
		const sendUploadEvent = (body: UPLOAD_RESULT): void => {
			const eventMessage: DAPMessage = {
				event: 'apaevt_status_upload',
				body: body as unknown as Record<string, unknown>,
				seq: 0,
				type: 'event',
			};
			this.onEvent(eventMessage);
		};

		/**
		 * Upload a single file - straightforward linear process:
		 * 1. Wait for pipe to become available (server handles queuing)
		 * 2. Transfer data
		 * 3. Close pipe
		 * 4. Send status update
		 */
		const uploadFile = async (fileData: { file: File; objinfo?: Record<string, unknown>; mimetype?: string }, index: number): Promise<void> => {
			const { file, objinfo = {}, mimetype } = fileData;
			const startTime = Date.now();
			let bytesUploaded = 0;
			let pipe: DataPipe | null = null;
			let error: string | undefined;
			let result: PIPELINE_RESULT | undefined;

			// Get file size: from filesystem when filepath in objinfo (Node.js), else file.size (same as Python os.path.getsize)
			let fileSize = file.size;
			if (typeof window === 'undefined' && objinfo?.filepath && typeof objinfo.filepath === 'string') {
				try {
					const fsPromises = await this._loadNodeFsPromises();
					fileSize = (await fsPromises.stat(objinfo.filepath as string)).size;
				} catch {
					// fallback to file.size
				}
			}

			const finalMimetype = mimetype || file.type || 'application/octet-stream';

			try {
				// Step 1: Create and open pipe (waits for server to allocate)
				pipe = await this.pipe(token, this._objinfoWithSize({ name: file.name, ...objinfo }, fileSize), finalMimetype);
				await pipe.open();

				// Step 2: Send status update AFTER we have the pipe
				sendUploadEvent({
					action: 'open',
					filepath: file.name,
					bytes_sent: 0,
					file_size: fileSize,
					upload_time: 0,
				});

				// Step 3: Transfer data in chunks
				const reader = file.stream().getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						await pipe.write(value);
						bytesUploaded += value.length;

						// Send progress updates during transfer
						sendUploadEvent({
							action: 'write',
							filepath: file.name,
							bytes_sent: bytesUploaded,
							file_size: fileSize,
							upload_time: (Date.now() - startTime) / 1000,
						});
					}
				} finally {
					reader.releaseLock();
				}

				// Step 4: Close pipe and get result
				sendUploadEvent({
					action: 'close',
					filepath: file.name,
					bytes_sent: bytesUploaded,
					file_size: fileSize,
					upload_time: (Date.now() - startTime) / 1000,
				});

				result = await pipe.close();
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}

			// Send final status
			const uploadTime = (Date.now() - startTime) / 1000;
			const finalResult: UPLOAD_RESULT = {
				action: error ? 'error' : 'complete',
				filepath: file.name,
				bytes_sent: bytesUploaded,
				file_size: fileSize,
				upload_time: uploadTime,
				result,
				error,
			};

			sendUploadEvent(finalResult);
			results[index] = finalResult;
		};

		// Create a promise for every file - let server handle queuing
		const uploadPromises = files.map((fileData, index) =>
			uploadFile(fileData, index).catch((err) => {
				// Ensure errors don't kill the whole batch
				console.error(`Upload failed for ${fileData.file.name}:`, err);
			})
		);

		// Wait for all uploads to complete
		await Promise.all(uploadPromises);

		return results;
	}

	// ============================================================================
	// CHAT METHODS
	// ============================================================================

	/**
	 * Ask a question to RocketRide's AI and get an intelligent response.
	 */
	async chat(options: { token: string; question: Question; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> }): Promise<PIPELINE_RESULT> {
		const { token, question, onSSE } = options;

		try {
			// Validate that we have a question to ask
			if (!question) {
				throw new Error('Question cannot be empty');
			}

			// Create unique identifier for this chat operation
			const objinfo = { name: `Question ${this._nextChatId}` };
			this._nextChatId += 1;

			// Create pipe instance — no provider filter so chat() works with chat, webhook,
			// and dropper sources. The rocketride-question MIME type routes to the 'questions' lane.
			const pipe = await this.pipe(token, objinfo, 'application/rocketride-question', undefined, onSSE);

			try {
				// Open the communication channel to the AI
				await pipe.open();

				// Send the question as JSON data to the AI system
				const questionJson = JSON.stringify(question.toDict());
				const questionBytes = new TextEncoder().encode(questionJson);
				await pipe.write(questionBytes);

				// Close the pipe and get the AI's response
				const result = await pipe.close();

				// Check it
				if (!result) {
					throw new Error('No response received from AI');
				}

				// Return success response in standard format
				return result;
			} finally {
				// Ensure the pipe is properly closed even if errors occur
				if (pipe.isOpened) {
					try {
						await pipe.close();
					} catch {
						// Ignore errors during cleanup
					}
				}
			}
		} catch (error) {
			// Return error response in standard format
			throw new Error(error instanceof Error ? error.message : String(error));
		}
	}

	// ============================================================================
	// EVENT METHODS
	// ============================================================================

	/**
	 * Send events to debugging interface if available (for development).
	 */
	private _sendVSCodeEvent(eventType: string, body: Record<string, unknown>): void {
		// Set up debugging integration on first use
		if (!this._dapAttempted) {
			this._dapAttempted = true;

			try {
				// In browser environment, check for debugging tools
				if (typeof window !== 'undefined') {
					const win = window as unknown as Record<string, Record<string, unknown>>;
					if (win.__ROCKETRIDE_DEBUG__) {
						this._dapSend = win.__ROCKETRIDE_DEBUG__.sendEvent as (event: unknown) => void;
					}
				}
			} catch {
				// Not in debugging environment - no problem
			}
		}

		// Send event to debugger if available
		if (this._dapSend) {
			const customEvent = {
				type: 'event',
				event: eventType,
				body: body,
			};
			this._dapSend(customEvent);
		}
	}

	/**
	 * Handle incoming events from the RocketRide server.
	 */
	async onEvent(message: DAPMessage): Promise<void> {
		// Extract event information
		const eventType = message.event || 'unknown';
		const eventBody = message.body || {};
		const seqNum = message.seq || 0;

		// Forward to debugging interface if available
		this._sendVSCodeEvent(eventType, eventBody);

		// Update cached ConnectResult when the server pushes a full account refresh
		if (eventType === 'apaext_account') {
			this._connectResult = eventBody as unknown as ConnectResult;
			if (this._connectResult?.userToken) {
				this._apikey = this._connectResult.userToken;
			}
		}

		// Dispatch pipe-scoped SSE events to the registered DataPipe callback
		if (eventType === 'apaevt_sse') {
			const pipeId = (eventBody as Record<string, unknown>)?.pipe_id as number | undefined;
			if (pipeId !== undefined) {
				const cb = this._ssePipeCallbacks.get(pipeId);
				if (cb) {
					try {
						const body = eventBody as Record<string, unknown>;
						const type = (body.type as string) ?? '';
						const data = (body.data as Record<string, unknown>) ?? {};
						await cb(type, data);
					} catch (error) {
						this.debugMessage(`Error in SSE callback for pipe ${pipeId}: ${error}`);
					}
				}
			}
		}

		// Call user-provided event handler if available
		if (this._callerOnEvent) {
			try {
				await this._callerOnEvent(message);
			} catch (error) {
				// Log errors but don't let user code break the connection
				this.debugMessage(`Error in user onEvent handler for ${eventType} (seq ${seqNum}): ${error}`);
			}
		}
	}

	/**
	 * Handle connection attempt failure.
	 * Calls the user callback and chains to parent.
	 */
	async onConnectError(error: Error): Promise<void> {
		if (this._callerOnConnectError) {
			try {
				const connectionError = error instanceof ConnectionException ? error : new ConnectionException({ message: String(error) });
				await this._callerOnConnectError(connectionError);
			} catch (e) {
				this.debugMessage(`Error in user onConnectError handler: ${e}`);
			}
		}
		await super.onConnectError(error);
	}

	/**
	 * Handle transport-level connected event.
	 *
	 * With the attach/login split, this fires when the WebSocket opens
	 * (before auth). The ``_internalLogin`` method handles the auth
	 * notification separately, so this is intentionally minimal.
	 */
	async onConnected(connectionInfo: string): Promise<void> {
		await super.onConnected(connectionInfo);
	}

	/**
	 * Handle transport disconnection.
	 *
	 * Clears transport and auth state, notifies the user callback,
	 * then consults ``_desiredState`` to decide whether to reconnect.
	 */
	async onDisconnected(reason: string, hasError: boolean): Promise<void> {
		// Transport is gone — clear so next attach creates a fresh one
		this._transport = undefined;
		this._connectResult = undefined;
		this._authenticated = false;

		// Notify user callback
		if (this._callerOnDisconnected) {
			try {
				await this._callerOnDisconnected(reason, hasError);
			} catch (error) {
				this.debugMessage(`Error in user onDisconnected handler for ${reason}: ${error}`);
			}
		}

		// Chain to parent to clear pending requests
		await super.onDisconnected(reason, hasError);

		// Reconnect engine: honour _desiredState
		if (this._desiredState === 'detached') return;
		if (!this._persist) { this._desiredState = 'detached'; return; }
		if (this._reconnectTimer) return; // engine already active

		this._currentReconnectDelay = 250;
		this._scheduleReconnect();
	}

	/**
	 * Subscribe to specific types of events from the server.
	 * @deprecated Use {@link addMonitor} / {@link removeMonitor} instead.
	 */
	async setEvents(token: string, eventTypes: string[], pipeId?: number): Promise<void> {
		// Build event subscription args
		const args: Record<string, unknown> = { types: eventTypes };
		if (pipeId !== undefined) args.pipeId = pipeId;

		try {
			await this.call('rrext_monitor', args, { token });
		} catch (err) {
			throw new Error(`Event subscription failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	// ============================================================================
	// MONITOR SUBSCRIPTION MANAGEMENT
	// ============================================================================

	/**
	 * Add a monitor subscription. If the key already exists, the new types are
	 * merged via reference counting and the merged set is sent to the server.
	 *
	 * @param key - Monitor key: `{ token }` for a running task, or `{ projectId, source }` for a project.
	 * @param types - Event types to subscribe to (e.g. `['summary', 'flow']`).
	 */
	async addMonitor(key: MonitorKey, types: string[]): Promise<void> {
		const keyStr = this._monitorKeyToString(key);
		let refCounts = this._monitorKeys.get(keyStr);
		if (!refCounts) {
			refCounts = new Map();
			this._monitorKeys.set(keyStr, refCounts);
		}

		// Increment reference counts
		for (const t of types) {
			refCounts.set(t, (refCounts.get(t) ?? 0) + 1);
		}

		// Send merged types to server — rollback on failure
		try {
			await this._syncMonitor(key, refCounts);
		} catch (error) {
			for (const t of types) {
				const current = refCounts.get(t) ?? 0;
				if (current <= 1) {
					refCounts.delete(t);
				} else {
					refCounts.set(t, current - 1);
				}
			}
			if (refCounts.size === 0) {
				this._monitorKeys.delete(keyStr);
			}
			throw error;
		}
	}

	/**
	 * Remove a monitor subscription. Decrements reference counts for the given
	 * types. Only unsubscribes a type from the server when its count reaches 0.
	 *
	 * @param key - Monitor key (must match the key used in addMonitor).
	 * @param types - Event types to unsubscribe from.
	 */
	async removeMonitor(key: MonitorKey, types: string[]): Promise<void> {
		const keyStr = this._monitorKeyToString(key);
		const refCounts = this._monitorKeys.get(keyStr);
		if (!refCounts) return;

		// Decrement reference counts
		for (const t of types) {
			const current = refCounts.get(t) ?? 0;
			if (current <= 1) {
				refCounts.delete(t);
			} else {
				refCounts.set(t, current - 1);
			}
		}

		// Send merged types (or unsubscribe if empty)
		await this._syncMonitor(key, refCounts);

		// Clean up empty keys
		if (refCounts.size === 0) {
			this._monitorKeys.delete(keyStr);
		}
	}

	/**
	 * Remove all monitor subscriptions from this client.
	 *
	 * Sends an empty types list for each active monitor key to unsubscribe
	 * on the server, then clears the local ref-count map.  Called by the
	 * shell when an app unmounts so the next app starts with a clean slate.
	 */
	async clearAllMonitors(): Promise<void> {
		const emptyMap = new Map<string, number>();
		for (const [keyStr] of this._monitorKeys) {
			const key = this._monitorStringToKey(keyStr);
			if (key) {
				try {
					await this._syncMonitor(key, emptyMap);
				} catch {
					// Best-effort — server may have already cleared
				}
			}
		}
		this._monitorKeys.clear();
	}

	/**
	 * Update this connection's display name on the server.
	 *
	 * Useful when an app plugin loads and wants the server monitor to show
	 * a more descriptive name (e.g. "Cloud Shell-UI — rocketride.pipeBuilder")
	 * instead of the generic client name sent at auth time.
	 *
	 * @param clientName - The new display name for this connection.
	 */
	async identify(clientName: string): Promise<void> {
		await this.call('rrext_identify', { clientName });
	}

	/**
	 * Send the merged type list for a monitor key to the server.
	 */
	private async _syncMonitor(key: MonitorKey, refCounts: Map<string, number>): Promise<void> {
		if (!this.isConnected()) return;

		const mergedTypes = Array.from(refCounts.keys());

		if ('token' in key) {
			await this.call('rrext_monitor', { types: mergedTypes }, { token: key.token });
		} else {
			const args: Record<string, unknown> = {
				projectId: key.projectId,
				source: key.source,
				types: mergedTypes,
			};
			if (key.pipeId !== undefined) {
				args.pipeId = key.pipeId;
			}
			await this.call('rrext_monitor', args);
		}
	}

	/**
	 * Replay all active monitor subscriptions to the server.
	 * Called automatically after reconnection.
	 */
	private async _resubscribeAllMonitors(): Promise<void> {
		for (const [keyStr, refCounts] of this._monitorKeys) {
			if (refCounts.size === 0) continue;
			const key = this._monitorStringToKey(keyStr);
			if (key) {
				try {
					await this._syncMonitor(key, refCounts);
				} catch (error) {
					this.debugMessage(`Failed to resubscribe monitor ${keyStr}: ${error}`);
				}
			}
		}
	}

	/**
	 * Convert a MonitorKey to a stable string for map lookup.
	 */
	private _monitorKeyToString(key: MonitorKey): string {
		if ('token' in key) {
			return `t:${key.token}`;
		}
		let s = `p:${key.projectId}.${key.source}`;
		if (key.pipeId !== undefined) {
			s += `.${key.pipeId}`;
		}
		return s;
	}

	/**
	 * Reverse a key-string back to a MonitorKey (for resubscribeAll).
	 */
	private _monitorStringToKey(keyStr: string): MonitorKey | null {
		if (keyStr.startsWith('t:')) {
			return { token: keyStr.slice(2) };
		}
		if (keyStr.startsWith('p:')) {
			const rest = keyStr.slice(2);
			const dotIdx = rest.indexOf('.');
			if (dotIdx === -1) return null;
			const projectId = rest.slice(0, dotIdx);
			const remaining = rest.slice(dotIdx + 1);
			const parts = remaining.split('.');
			if (parts.length === 2 && !isNaN(Number(parts[1]))) {
				return { projectId, source: parts[0], pipeId: Number(parts[1]) };
			}
			return { projectId, source: remaining };
		}
		return null;
	}

	// ============================================================================
	// TEMPLATE STORAGE MANAGEMENT (convenience wrappers using fsReadJson/fsWriteJson)
	// ============================================================================

	/**
	 * Persist a pipeline configuration as a named template in the account store.
	 *
	 * Templates are stored as JSON files under `.templates/<templateId>.json`.
	 * Saving a template with an existing ID overwrites the previous version.
	 *
	 * @param options.templateId - Unique identifier for the template (no path separators)
	 * @param options.pipeline - Pipeline configuration object to save
	 * @throws Error if templateId is invalid or pipeline is not a non-empty object
	 */
	async saveTemplate(options: { templateId: string; pipeline: Record<string, any> }): Promise<void> {
		// Validate the template ID to prevent path traversal or invalid filenames
		this.validateId(options.templateId, 'templateId');
		// Ensure the pipeline payload is a non-null object before writing
		if (!options.pipeline || typeof options.pipeline !== 'object') throw new Error('pipeline must be a non-empty object');

		// Serialise and write the pipeline under the .templates virtual directory
		await this.fsWriteJson(`.templates/${options.templateId}.json`, options.pipeline);
	}

	/**
	 * Retrieve a previously saved pipeline template from the account store.
	 *
	 * @param options.templateId - Unique identifier of the template to retrieve
	 * @returns The pipeline configuration object that was saved
	 * @throws Error if the template does not exist or templateId is invalid
	 */
	async getTemplate(options: { templateId: string }): Promise<Record<string, any>> {
		// Validate the ID before constructing the storage path
		this.validateId(options.templateId, 'templateId');

		// Read and parse the JSON file from the .templates virtual directory
		return this.fsReadJson(`.templates/${options.templateId}.json`);
	}

	/**
	 * Delete a pipeline template from the account store.
	 *
	 * @param options.templateId - Unique identifier of the template to delete
	 * @throws Error if the template does not exist or templateId is invalid
	 */
	async deleteTemplate(options: { templateId: string }): Promise<void> {
		// Validate the ID before constructing the storage path
		this.validateId(options.templateId, 'templateId');

		// Delete the JSON file from the .templates virtual directory
		await this.fsDelete(`.templates/${options.templateId}.json`);
	}

	/**
	 * List all pipeline templates stored in the account store.
	 *
	 * Reads the `.templates` directory, parses each `.json` file, and extracts
	 * a summary for each template. Files that cannot be parsed are silently
	 * skipped so a single corrupt template does not break the entire listing.
	 *
	 * @returns Array of template summaries sorted in directory-listing order.
	 *          Each entry contains the template ID, display name, source components,
	 *          and total component count.
	 */
	async getAllTemplates(): Promise<Array<{ id: string; name: string; sources: any[]; totalComponents: number }>> {
		// Fetch the list of entries under the .templates virtual directory
		const dir = await this.fsListDir('.templates');
		const templates: Array<{ id: string; name: string; sources: any[]; totalComponents: number }> = [];

		for (const entry of dir.entries) {
			// Skip directories and any non-JSON files (e.g. temp files)
			if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue;
			try {
				// Derive the template ID by stripping the .json extension
				const id = entry.name.slice(0, -5);
				// Load and parse the template JSON
				const pipeline = await this.fsReadJson(`.templates/${entry.name}`);
				// Extract Source-mode components to populate the sources summary list
				const sources = (pipeline.components || []).filter((c: any) => c.config?.mode === 'Source').map((c: any) => ({ id: c.id, provider: c.provider, name: c.config?.name || c.id }));
				// Push the summary (use template ID as display name)
				templates.push({ id, name: id, sources, totalComponents: (pipeline.components || []).length });
			} catch (err) {
				// Log the failure but continue so one bad file doesn't block others
				console.debug(`[RocketRideClient] Failed to read .templates/${entry.name}:`, err);
				continue;
			}
		}

		return templates;
	}

	// ============================================================================
	// LOG STORAGE MANAGEMENT (convenience wrappers using fsReadJson/fsWriteJson)
	// ============================================================================

	/**
	 * Persist a pipeline execution log to the account store.
	 *
	 * Logs are stored under `.logs/<projectId>/<source>-<startTime>.log`.
	 * The filename is derived from `contents.body.startTime` so logs are
	 * naturally sortable by execution start time.
	 *
	 * @param options.projectId - Project identifier that owns this log
	 * @param options.source - Source component identifier the log is associated with
	 * @param options.contents - Log payload; must contain `body.startTime`
	 * @returns The generated filename (e.g. `"ingest-1714000000000.log"`)
	 * @throws Error if any ID is invalid, contents is not an object, or startTime is missing
	 */
	async saveLog(options: { projectId: string; source: string; contents: Record<string, any> }): Promise<string> {
		// Validate identifiers to prevent path traversal
		this.validateId(options.projectId, 'projectId');
		this.validateId(options.source, 'source');
		// Ensure the contents payload is a non-null object
		if (!options.contents || typeof options.contents !== 'object') throw new Error('contents must be a non-empty object');

		// startTime is required; it forms part of the filename for chronological ordering.
		// Reject anything other than a non-empty number or numeric-looking string to
		// prevent path-separator chars from slipping into the generated filename.
		const startTime = options.contents?.body?.startTime;
		if (startTime === undefined || startTime === null) throw new Error('contents must contain body.startTime');
		if (typeof startTime !== 'number' && typeof startTime !== 'string') {
			throw new Error('contents.body.startTime must be a number or string');
		}
		const startTimeStr = String(startTime);
		if (!startTimeStr || /[\\/]/.test(startTimeStr)) {
			throw new Error('contents.body.startTime must not be empty or contain path separators');
		}

		// Construct a deterministic filename from source and start time
		const filename = `${options.source}-${startTimeStr}.log`;
		// Write the log JSON to the per-project logs directory
		await this.fsWriteJson(`.logs/${options.projectId}/${filename}`, options.contents);
		return filename;
	}

	/**
	 * Retrieve a previously saved pipeline execution log from the account store.
	 *
	 * @param options.projectId - Project identifier that owns the log
	 * @param options.name - Filename of the log (as returned by saveLog)
	 * @returns The log payload that was saved
	 * @throws Error if the log does not exist or projectId is invalid
	 */
	async getLog(options: { projectId: string; name: string }): Promise<Record<string, any>> {
		// Validate the project ID before constructing the storage path
		this.validateId(options.projectId, 'projectId');
		if (!options.name) throw new Error('name is required');

		// Read and parse the log JSON from the per-project logs directory
		return this.fsReadJson(`.logs/${options.projectId}/${options.name}`);
	}

	/**
	 * Delete a pipeline execution log from the account store.
	 *
	 * @param options.projectId - Project identifier that owns the log
	 * @param options.name - Filename of the log to delete
	 * @throws Error if the log does not exist or projectId is invalid
	 */
	async deleteLog(options: { projectId: string; name: string }): Promise<void> {
		// Validate the project ID before constructing the storage path
		this.validateId(options.projectId, 'projectId');
		if (!options.name) throw new Error('name is required');

		// Delete the log file from the per-project logs directory
		await this.fsDelete(`.logs/${options.projectId}/${options.name}`);
	}

	/**
	 * List pipeline execution logs stored for a project, optionally filtered by source.
	 *
	 * Results are sorted ascending by `modified` timestamp so the oldest log
	 * appears first. The caller can page through or slice the array as needed.
	 *
	 * @param options.projectId - Project identifier whose logs to list
	 * @param options.source - Optional source component filter; when set, only logs
	 *                         whose filename starts with `<source>-` are returned
	 * @returns Array of log name and optional modified timestamp, sorted oldest-first
	 * @throws Error if projectId (or source when provided) is invalid
	 */
	async listLogs(options: { projectId: string; source?: string }): Promise<Array<{ name: string; modified?: number }>> {
		// Validate identifiers before constructing the storage path
		this.validateId(options.projectId, 'projectId');
		if (options.source) this.validateId(options.source, 'source');

		// List all entries in the per-project logs directory
		const dir = await this.fsListDir(`.logs/${options.projectId}`);
		// Keep only .log files and map to the public shape (name + modified)
		let logs = dir.entries.filter((e) => e.type === 'file' && e.name.endsWith('.log')).map((e) => ({ name: e.name, modified: e.modified }));

		// Apply optional source prefix filter when a source was specified
		if (options.source) {
			logs = logs.filter((l) => l.name.startsWith(`${options.source}-`));
		}

		// Sort ascending by modified timestamp; treat missing timestamps as epoch 0
		logs.sort((a, b) => (a.modified || 0) - (b.modified || 0));
		return logs;
	}

	// ============================================================================
	// HANDLE-BASED FILE STORE OPERATIONS
	// ============================================================================

	/**
	 * Open a file handle for reading or writing.
	 *
	 * @param path - Relative path within the account store
	 * @param mode - 'r' for read, 'w' for write (default: 'r')
	 * @param offset - Initial byte offset (read mode only)
	 * @returns Object with 'handle' (string). Read mode also includes 'size' (number).
	 */
	async fsOpen(path: string, mode: 'r' | 'w' = 'r'): Promise<{ handle: string; size?: number }> {
		this.validateStorePath(path);
		return this.call('rrext_store', { subcommand: 'fs_open', path, mode });
	}

	/**
	 * Read data from an open read handle.
	 *
	 * @param handle - Handle ID returned by fsOpen
	 * @param offset - Byte offset to read from
	 * @param length - Max bytes to read (default 4 MB). Empty Uint8Array indicates EOF.
	 * @returns The bytes read
	 */
	async fsRead(handle: string, offset: number = 0, length: number = 4_194_304): Promise<Uint8Array> {
		// Bypass call() which unwraps response.body, losing response.arguments
		// where the server places the binary data payload.
		const message = this.buildRequest('rrext_store', {
			arguments: { subcommand: 'fs_read', handle, offset, length },
		});
		this._onTrace?.(TraceType.Request, message);
		const response = await this.request(message);
		if (response.success === false) {
			this._onTrace?.(TraceType.Error, response);
			throw new Error(response.message ?? 'fs_read failed');
		}
		this._onTrace?.(TraceType.Success, response);
		return ((response as any).arguments?.data as Uint8Array) || new Uint8Array(0);
	}

	/**
	 * Write data to an open write handle.
	 *
	 * @param handle - Handle ID returned by fsOpen
	 * @param data - Raw bytes to write
	 * @returns Number of bytes written
	 */
	async fsWrite(handle: string, data: Uint8Array): Promise<number> {
		const body = await this.call('rrext_store', { subcommand: 'fs_write', handle, data });
		return (body as any)?.bytesWritten ?? 0;
	}

	/**
	 * Close a file handle.
	 *
	 * @param handle - Handle ID returned by fsOpen
	 * @param mode - 'r' or 'w' (must match the mode used in fsOpen)
	 */
	async fsClose(handle: string, mode: 'r' | 'w'): Promise<void> {
		await this.call('rrext_store', { subcommand: 'fs_close', handle, mode });
	}

	/**
	 * Delete a file.
	 *
	 * @param path - Relative path within the account store
	 * @throws Error if file does not exist or delete fails
	 */
	async fsDelete(path: string): Promise<void> {
		this.validateStorePath(path);
		await this.call('rrext_store', { subcommand: 'fs_delete', path });
	}

	/**
	 * List immediate children of a directory.
	 *
	 * @param path - Relative directory path (default: account root)
	 * @returns Directory entries with name and type (file or dir)
	 */
	async fsListDir(path: string = ''): Promise<{ entries: Array<{ name: string; type: 'file' | 'dir'; size?: number; modified?: number }>; count: number }> {
		if (path) this.validateStorePath(path);
		return this.call('rrext_store', { subcommand: 'fs_list_dir', path });
	}

	/**
	 * Create a directory.
	 *
	 * @param path - Relative directory path
	 */
	async fsMkdir(path: string): Promise<void> {
		this.validateStorePath(path);
		await this.call('rrext_store', { subcommand: 'fs_mkdir', path });
	}

	/**
	 * Remove a directory.
	 *
	 * @param path - Relative directory path
	 * @param recursive - If true, delete contents recursively (default: false)
	 * @throws Error if directory is not empty (when recursive is false) or delete fails
	 */
	async fsRmdir(path: string, recursive: boolean = false): Promise<void> {
		this.validateStorePath(path);
		await this.call('rrext_store', { subcommand: 'fs_rmdir', path, recursive });
	}

	/**
	 * Get file or directory metadata.
	 *
	 * @param path - Relative path within the account store
	 * @returns Metadata including existence, type, size (bytes), and modified epoch timestamp (for files)
	 */
	async fsStat(path: string): Promise<{ exists: boolean; type?: 'file' | 'dir'; size?: number; modified?: number }> {
		this.validateStorePath(path);
		return this.call('rrext_store', { subcommand: 'fs_stat', path });
	}

	/**
	 * Rename a file or directory.
	 *
	 * On object stores this is implemented as copy + delete. For directories,
	 * all contents are moved recursively.
	 *
	 * @param oldPath - Current relative path within the account store
	 * @param newPath - New relative path within the account store
	 * @throws Error if oldPath does not exist or rename fails
	 */
	async fsRename(oldPath: string, newPath: string): Promise<void> {
		this.validateStorePath(oldPath);
		this.validateStorePath(newPath);
		await this.call('rrext_store', { subcommand: 'fs_rename', old_path: oldPath, new_path: newPath });
	}

	/**
	 * Get a direct HTTP URL for accessing a file in the store.
	 *
	 * For cloud backends (S3, Azure) this returns a presigned/SAS URL.
	 * For local filesystem backends this returns a JWT-signed URL pointing
	 * at the server's `/task/fetch` endpoint.
	 *
	 * The returned URL can be used directly as `src` on `<img>`, `<video>`,
	 * `<audio>`, and `<iframe>` elements for native browser streaming.
	 *
	 * @param path - Relative path within the account store
	 * @param expiresIn - URL validity in seconds (default 3600)
	 * @param downloadName - If set, the URL forces a browser download with this
	 *   filename (`Content-Disposition: attachment`). This is the only reliable
	 *   way to control the download filename for cross-origin cloud URLs, where
	 *   the `<a download>` attribute is ignored. Omit for inline streaming.
	 * @returns A direct HTTP(S) URL to the file
	 */
	async fsGetUrl(path: string, expiresIn: number = 3600, downloadName?: string): Promise<string> {
		this.validateStorePath(path);
		const body = await this.call('rrext_store', {
			subcommand: 'fs_geturl',
			path,
			expires_in: expiresIn,
			download_name: downloadName,
		});
		return (body as any).url;
	}

	// ============================================================================
	// CONVENIENCE WRAPPERS (text/JSON over binary, handle open/close internally)
	// ============================================================================

	/** Read a file as a UTF-8 string. */
	async fsReadString(path: string): Promise<string> {
		const { handle } = await this.fsOpen(path, 'r');
		try {
			const chunks: Uint8Array[] = [];
			let offset = 0;
			while (true) {
				const chunk = await this.fsRead(handle, offset);
				if (chunk.length === 0) break;
				chunks.push(chunk);
				offset += chunk.length;
			}
			const total = new Uint8Array(offset);
			let pos = 0;
			for (const chunk of chunks) {
				total.set(chunk, pos);
				pos += chunk.length;
			}
			return new TextDecoder().decode(total);
		} finally {
			await this.fsClose(handle, 'r');
		}
	}

	/** Write a UTF-8 string to a file. */
	async fsWriteString(path: string, text: string): Promise<void> {
		const { handle } = await this.fsOpen(path, 'w');
		try {
			await this.fsWrite(handle, new TextEncoder().encode(text));
			await this.fsClose(handle, 'w');
		} catch (err) {
			try {
				await this.fsClose(handle, 'w');
			} catch {
				/* best-effort */
			}
			throw err;
		}
	}

	/** Read a JSON file. */
	async fsReadJson<T = any>(path: string): Promise<T> {
		const text = await this.fsReadString(path);
		return JSON.parse(text);
	}

	/** Write an object as JSON. */
	async fsWriteJson(path: string, obj: any): Promise<void> {
		await this.fsWriteString(path, JSON.stringify(obj, null, 2));
	}

	// ============================================================================
	// PATH AND ID VALIDATION
	// ============================================================================

	/**
	 * Characters that are illegal in store paths and IDs on all supported
	 * platforms (Windows, Linux, macOS, and object-storage back-ends).
	 *
	 * `\x00` is the null byte; the rest are shell/filesystem metacharacters
	 * that would cause ambiguous or dangerous behaviour in path construction.
	 */
	private static readonly INVALID_PATH_CHARS = new Set(['*', '?', '<', '>', '|', '"', '\x00']);

	/**
	 * Validate a relative path intended for the account file store.
	 *
	 * Splits the path on `/` (after normalising backslashes) and checks every
	 * segment for path-traversal attempts (`..`) and forbidden characters.
	 * Empty segments (from leading/trailing/double slashes) are skipped because
	 * they carry no security risk on the server side.
	 *
	 * @param path - Relative path to validate (e.g. `.templates/my-pipe.json`)
	 * @throws Error if any segment is `..` or contains illegal characters
	 */
	private validateStorePath(path: string): void {
		// Reject absolute paths — store paths must be relative
		if (path.startsWith('/') || path.startsWith('\\')) {
			throw new Error(`Path must be relative (got ${path})`);
		}
		// Normalise Windows-style backslashes to forward slashes before splitting
		for (const segment of path.replace(/\\/g, '/').split('/')) {
			// Reject parent-directory traversal attempts in any position of the path
			if (segment === '..') throw new Error(`Path traversal not allowed: ${path}`);
			// Only validate non-empty segments (empty ones arise from leading/trailing slashes)
			if (segment) {
				for (const ch of segment) {
					// Reject forbidden metacharacters and ASCII control characters (< 0x20)
					if (RocketRideClient.INVALID_PATH_CHARS.has(ch) || ch.charCodeAt(0) < 0x20) {
						throw new Error(`Path contains invalid characters: ${path}`);
					}
				}
			}
		}
	}

	/**
	 * Validate a single identifier (projectId, source, templateId, etc.) used
	 * to construct store paths.
	 *
	 * IDs must be non-empty strings that contain no path separators and no
	 * characters from the forbidden set. This prevents an ID from escaping its
	 * intended directory when interpolated into a path.
	 *
	 * @param value - The identifier string to validate
	 * @param name - Human-readable field name used in error messages (e.g. `"projectId"`)
	 * @throws Error if value is empty, contains path separators, or contains illegal characters
	 */
	private validateId(value: string, name: string): void {
		// Require a non-empty value
		if (!value) throw new Error(`${name} is required`);
		// Reject forward and backward slashes to prevent path injection
		if (value.includes('/') || value.includes('\\')) throw new Error(`${name} must not contain path separators`);
		// Reject any forbidden metacharacter or ASCII control character
		for (const ch of value) {
			if (RocketRideClient.INVALID_PATH_CHARS.has(ch) || ch.charCodeAt(0) < 0x20) {
				throw new Error(`${name} contains invalid characters: ${value}`);
			}
		}
	}

	// ============================================================================
	// DASHBOARD METHODS
	// ============================================================================

	/**
	 * Retrieve a server dashboard snapshot.
	 *
	 * Returns the current state of all connections, tasks, and aggregate
	 * metrics from the server. Requires 'task.monitor' permission.
	 *
	 * @returns DashboardResponse containing overview, connections, and tasks
	 */
	async getDashboard(): Promise<DashboardResponse> {
		return this.call<DashboardResponse>('rrext_dashboard', {});
	}

	// ============================================================================
	// CPROFILE PROFILING
	// ============================================================================

	/**
	 * Start a cProfile profiling session on the server process or a pipeline.
	 *
	 * @param target  - Task token to profile a pipeline subprocess, or
	 *                  undefined/null to profile the server process itself.
	 * @param session - Optional human-readable session name.
	 * @returns Status object with session info and start time.
	 */
	async cprofileStart(target?: string | null, session?: string): Promise<CProfileStatusResponse> {
		const args: Record<string, unknown> = {};
		if (target) args.target = target;
		if (session) args.session = session;
		return this.call<CProfileStatusResponse>('rrext_cprofile_start', args);
	}

	/**
	 * Stop the active cProfile profiling session.
	 *
	 * @param target - Task token if profiling a pipeline, or undefined for server.
	 * @returns Result with session name and runtime.
	 */
	async cprofileStop(target?: string | null): Promise<CProfileStopResponse> {
		const args: Record<string, unknown> = {};
		if (target) args.target = target;
		return this.call<CProfileStopResponse>('rrext_cprofile_stop', args);
	}

	/**
	 * Get the current cProfile profiling status.
	 *
	 * @param target - Task token if querying a pipeline, or undefined for server.
	 * @returns Status indicating active/inactive, owner, runtime.
	 */
	async cprofileStatus(target?: string | null): Promise<CProfileStatusResponse> {
		const args: Record<string, unknown> = {};
		if (target) args.target = target;
		return this.call<CProfileStatusResponse>('rrext_cprofile_status', args);
	}

	/**
	 * Get the full cProfile report from the last completed session.
	 *
	 * @param target - Task token if querying a pipeline, or undefined for server.
	 * @returns Object containing the full pstats text report.
	 */
	async cprofileReport(target?: string | null): Promise<CProfileReportResponse> {
		const args: Record<string, unknown> = {};
		if (target) args.target = target;
		return this.call<CProfileReportResponse>('rrext_cprofile_report', args);
	}

	/**
	 * Get a structured call tree from the last completed profiling session.
	 *
	 * Returns a hierarchical JSON tree suitable for flame graph, sunburst,
	 * and icicle visualisations.  Supports optional depth and minimum
	 * percentage pruning parameters.
	 *
	 * @param target   - Task token if querying a pipeline, or undefined for server.
	 * @param maxDepth - Maximum tree depth (default 50).
	 * @param minPct   - Minimum cumtime percentage threshold (default 0.1).
	 * @returns Object containing the tree root, total_time, and total_calls.
	 */
	async cprofileReportTree(
		target?: string | null,
		maxDepth?: number,
		minPct?: number,
		includeSystem?: boolean,
	): Promise<CProfileReportTreeResponse> {
		const args: Record<string, unknown> = {};
		if (target) args.target = target;
		if (maxDepth !== undefined) args.max_depth = maxDepth;
		if (minPct !== undefined) args.min_pct = minPct;
		if (includeSystem !== undefined) args.include_system = includeSystem;
		return this.call<CProfileReportTreeResponse>('rrext_cprofile_report_tree', args);
	}

	// ============================================================================
	// CONTEXT MANAGER SUPPORT - Python-style async context manager
	// ============================================================================

	/**
	 * Async disposal support for 'await using' pattern.
	 * Equivalent to Python's __aexit__
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.disconnect();
	}

	/**
	 * Static factory method for automatic connection management.
	 * Equivalent to Python's async with pattern
	 */
	static async withConnection<T>(config: RocketRideClientConfig, callback: (client: RocketRideClient) => Promise<T>): Promise<T> {
		const client = new RocketRideClient(config);
		try {
			await client.connect(config.auth);
			return await callback(client);
		} finally {
			await client.disconnect();
		}
	}

	// ============================================================================
	// SERVICES METHODS
	// ============================================================================

	/**
	 * Retrieve all available service definitions from the server.
	 *
	 * Returns a dictionary containing all service definitions available on
	 * the connected RocketRide server. Each service definition includes schemas,
	 * UI schemas, and configuration metadata.
	 *
	 * @returns Promise resolving to object mapping service names to their definitions
	 * @throws Error if the request fails or server returns an error
	 *
	 * @example
	 * ```typescript
	 * // Get all available services
	 * const services = await client.getServices();
	 *
	 * // List available service names
	 * for (const name of Object.keys(services)) {
	 *   console.log(`Available service: ${name}`);
	 * }
	 *
	 * // Access a specific service's schema
	 * if (services['ocr']) {
	 *   console.log('OCR schema:', services['ocr'].schema);
	 * }
	 * ```
	 */
	async getServices(): Promise<ServicesResponse> {
		return this.call<ServicesResponse>('rrext_services', {});
	}

	/**
	 * Retrieve a specific service definition from the server.
	 *
	 * Returns the definition for a specific service (connector) by name.
	 * The definition includes schemas, UI schemas, and configuration metadata.
	 *
	 * @param service - Name of the service to retrieve (e.g., 'ocr', 'embed', 'chat')
	 * @returns Promise resolving to service definition or undefined if not found
	 * @throws Error if the request fails or server returns an error
	 *
	 * @example
	 * ```typescript
	 * // Get OCR service definition
	 * const ocr = await client.getService('ocr');
	 * if (ocr) {
	 *   console.log('OCR schema:', ocr.schema);
	 *   console.log('OCR UI schema:', ocr.uiSchema);
	 * } else {
	 *   console.log('OCR service not available');
	 * }
	 * ```
	 */
	async getService(service: string): Promise<ServiceDefinition | undefined> {
		if (!service) {
			throw new Error('Service name is required');
		}

		return this.call<ServiceDefinition>('rrext_services', { service });
	}

	// ============================================================================
	// ADDITIONAL CONVENIENCE METHODS
	// ============================================================================

	/**
	 * Get connection information (TypeScript-specific convenience)
	 */
	getConnectionInfo(): {
		connected: boolean;
		transport: string;
		uri: string;
	} {
		return {
			connected: this.isConnected(),
			transport: 'WebSocket',
			uri: this._uri,
		};
	}

	/**
	 * Get API key (for debugging/validation)
	 */
	getApiKey(): string | undefined {
		return this._apikey;
	}

	// ============================================================================
	// ACCOUNT, BILLING & DEPLOY NAMESPACES
	// ============================================================================

	/**
	 * Lazily-initialised account API namespace.
	 *
	 * Provides typed methods for managing the authenticated user's profile,
	 * API keys, organization, members, and teams.
	 *
	 * @example
	 * ```typescript
	 * const profile = await client.account.getProfile();
	 * ```
	 */
	get account(): AccountApi {
		if (!this._account) {
			this._account = new AccountApi(this);
		}
		return this._account;
	}

	/**
	 * Lazily-initialised billing API namespace.
	 *
	 * Provides typed methods for managing subscriptions, Stripe checkout
	 * sessions, billing portal access, and compute credit wallets.
	 *
	 * @example
	 * ```typescript
	 * const details = await client.billing.getDetails(orgId);
	 * ```
	 */
	get billing(): BillingApi {
		if (!this._billing) {
			this._billing = new BillingApi(this);
		}
		return this._billing;
	}

	/**
	 * Lazily-initialised database API namespace.
	 *
	 * Provides direct SQL/Cypher execution against database pipelines, bypassing
	 * the LLM translation layer that {@link RocketRideClient.chat} uses.
	 *
	 * @example
	 * ```typescript
	 * const result = await client.database.query({ token, sql: 'SELECT 1' });
	 * ```
	 */
	get database(): DatabaseApi {
		if (!this._database) {
			this._database = new DatabaseApi(this);
		}
		return this._database;
	}

	/**
	 * Lazily-initialised deploy API namespace.
	 *
	 * Provides typed methods for managing server-side pipeline deployments:
	 * add, remove, list, status, and update.
	 *
	 * @example
	 * ```typescript
	 * const rec = await client.deploy.add(pipeline, { schedule: '0/15 * * * *' });
	 * ```
	 */
	get deploy(): DeployApi {
		if (!this._deploy) {
			this._deploy = new DeployApi(this);
		}
		return this._deploy;
	}

	// ============================================================================
	// CALL — PUBLIC DAP COMMAND INTERFACE
	// ============================================================================

	/**
	 * Sends a DAP command, unwraps the response body, and throws on failure.
	 *
	 * This is the single public entry point for all typed DAP operations.
	 * The {@link AccountApi} and {@link BillingApi} namespaces delegate here.
	 *
	 * If an `onTrace` callback was provided in the constructor config, it is
	 * invoked before the request (TraceType.Request) and after completion
	 * (TraceType.Success or TraceType.Error).
	 *
	 * @param command - DAP command name (e.g. "rrext_account_me").
	 * @param args    - Key/value arguments forwarded in the request.
	 * @param options - Optional token (for task-scoped calls) and timeout in ms.
	 * @returns The `body` field of a successful DAP response.
	 * @throws Error if the server signals failure.
	 */
	async call<T = any>(command: string, args?: Record<string, unknown>, options?: { token?: string; timeout?: number }): Promise<T> {
		// Build the raw DAP request
		const message = this.buildRequest(command, {
			arguments: args,
			token: options?.token,
		});

		// Trace: outbound request
		this._onTrace?.(TraceType.Request, message);

		const response = await this.request(message, options?.timeout);

		// Throw on server-reported failure
		if (response.success === false) {
			this._onTrace?.(TraceType.Error, response);
			throw new Error(response.message ?? `${command} failed`);
		}

		// Trace: success response
		this._onTrace?.(TraceType.Success, response);

		// Unwrap the body envelope
		return (response.body ?? response) as T;
	}

	/**
	 * Invoke a @tool_function on a pipeline node.
	 *
	 * Sends a `tool` subcommand through the DAP data connection.  The server
	 * borrows a pipeline instance from the pool, dispatches the tool call
	 * through the control plane, and returns the result directly — no
	 * Question, Answer, or SSE overhead.
	 *
	 * @param options.token - Pipeline token for authentication and resource access
	 * @param options.tool - Name of the @tool_function to invoke (e.g. 'search', 'list', 'execute')
	 * @param options.nodeId - Target node ID.  When empty the call broadcasts to all
	 *                         tool-lane nodes; the first node that owns the tool handles it.
	 * @param options.input - Arguments forwarded to the tool function
	 * @param options.timeout - Optional per-request timeout in ms
	 * @returns The tool's return value (typically a record/object)
	 * @throws Error if the server signals failure or no node handles the requested tool
	 */
	async tool<T = any>(options: {
		token: string;
		tool: string;
		nodeId?: string;
		input?: Record<string, unknown>;
		timeout?: number;
	}): Promise<T> {
		const result = await this.call<{ result: T }>('rrext_process', {
			subcommand: 'tool',
			tool: options.tool,
			nodeId: options.nodeId ?? '',
			input: options.input ?? {},
		}, {
			token: options.token,
			timeout: options.timeout,
		});
		return result.result;
	}
}

export { RocketRideClient as default };
