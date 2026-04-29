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
import { DAPMessage, EventCallback, RocketRideClientConfig, ConnectCallback, DisconnectCallback, ConnectErrorCallback, ConnectResult, TraceType } from './types/index.js';
import { TASK_STATUS, UPLOAD_RESULT, PIPELINE_RESULT, PipelineConfig, DashboardResponse, ServicesResponse, ServiceDefinition, ValidationResult } from './types/index.js';
import { CONST_DEFAULT_WEB_CLOUD, CONST_DEFAULT_WEB_PROTOCOL, CONST_DEFAULT_WEB_PORT } from './constants.js';
import { Question } from './schema/Question.js';
import { AccountApi } from './account.js';
import { BillingApi } from './billing.js';
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
			const msg =
				`${base}\n\n` +
				'Common causes:\n' +
				"- Pipeline isn't running (wrong token or task terminated)\n" +
				"- Pipeline source is 'chat' (use client.chat()), not webhook/dropper\n" +
				"- MIME type doesn't match the source lane (try mimeType='text/plain')\n";
			throw new PipeException({ ...response, message: msg });
		}

		this._pipeId = response.body?.pipe_id as number | undefined;
		this._opened = true;

		// If an SSE callback was provided, subscribe and register for this pipe
		if (this._onSSE !== undefined && this._pipeId !== undefined) {
			try {
				await this._client.setEvents(this._token, ['SSE'], this._pipeId);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				const msg = `Failed to subscribe to SSE events for this data pipe.\n\n${errMsg}`;
				throw new PipeException({ message: msg });
			}

			this._client._ssePipeCallbacks.set(this._pipeId, this._onSSE);
		}

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
		if (!this._opened || this._closed) {
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

	// Persistence properties for automatic reconnection
	private _persist: boolean = false;
	private _reconnectTimeout?: ReturnType<typeof setTimeout>;
	private _manualDisconnect: boolean = false;
	private _maxRetryTime?: number;
	private _retryStartTime?: number;
	private _currentReconnectDelay: number = 500;

	/** True after onConnected has been invoked; used to only invoke onDisconnected when we had a connection. */
	private _didNotifyConnected: boolean = false;

	/** Stored ConnectResult from the last successful connect(). */
	private _connectResult?: ConnectResult;

	/** Reference-counted monitor subscriptions: keyString → Map<eventType, refCount> */
	private _monitorKeys = new Map<string, Map<string, number>>();

	/** Lazily-created account API namespace. */
	private _account?: AccountApi;

	/** Lazily-created billing API namespace. */
	private _billing?: BillingApi;

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

		const { auth = config.auth, uri = config.uri || clientEnv.ROCKETRIDE_URI || CONST_DEFAULT_WEB_CLOUD, onEvent, onConnected, onDisconnected, onConnectError, persist, maxRetryTime, module } = config;

		// Create unique client identifier
		const clientName = module || `CLIENT-${clientId++}`;

		// Initialize the DAPClient without a transport; transport is created in _internalConnect (CONNECTION_LOGIC.md §3)
		super(clientName, undefined, config);

		// Store connection details and environment
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
		this._maxRetryTime = maxRetryTime;
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
	 * Normalize a user-provided URI into a fully-formed WebSocket address.
	 * Builds on normalizeUri, then converts to ws/wss and appends /task/service.
	 */
	private _getWebsocketUri(uri: string): string {
		const httpUrl = RocketRideClient.normalizeUri(uri);

		try {
			const url = new URL(httpUrl);
			const wsScheme = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
			return `${wsScheme}//${url.host}/task/service`;
		} catch {
			return `${httpUrl}/task/service`;
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

	/**
	 * Clear any pending reconnection timeout.
	 */
	private _clearReconnectTimeout(): void {
		if (this._reconnectTimeout) {
			clearTimeout(this._reconnectTimeout);
			this._reconnectTimeout = undefined;
		}
	}

	// ============================================================================
	// CONNECTION METHODS
	// ============================================================================

	/**
	 * Single place for physical connection. Creates transport if needed, then
	 * calls DAPClient.connect (transport connect + auth handshake + onConnected).
	 * Returns the auth response body (ConnectResult) on success.
	 */
	private async _internalConnect(timeout?: number): Promise<Record<string, unknown>> {
		if (!this._transport) {
			const transport = new TransportWebSocket(this._uri, this._apikey!);
			this._bindTransport(transport);
		}
		return super._dapConnect(timeout);
	}

	/**
	 * Single place for physical disconnect. Closes the transport directly,
	 * which triggers onDisconnected via the transport callback.
	 */
	private async _internalDisconnect(): Promise<void> {
		if (!this._transport) return;
		await this._transport.disconnect();
	}

	/**
	 * Try to connect; on auth error notify and stop; on other error notify and
	 * reschedule with exponential backoff. Used by persist-mode connect() and
	 * by the reconnect timer.
	 * Returns the ConnectResult on success, undefined on failure.
	 */
	private async _attemptConnection(timeout?: number): Promise<ConnectResult | undefined> {
		try {
			const body = await this._internalConnect(timeout);
			this._connectResult = body as unknown as ConnectResult;
			// In persist mode, keep userToken for automatic reconnect
			if (this._connectResult?.userToken) {
				this._apikey = this._connectResult.userToken;
			}
			this._reconnectTimeout = undefined;
			this.debugMessage('Connection successful');
			return this._connectResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.debugMessage(`Connection failed: ${err}`);
			await this.onConnectError(err);

			if (error instanceof AuthenticationException) {
				return undefined;
			}

			if (this._retryStartTime === undefined) {
				this._retryStartTime = Date.now();
			}

			if (this._maxRetryTime !== undefined) {
				if (Date.now() - this._retryStartTime >= this._maxRetryTime) {
					return undefined;
				}
			}

			this._currentReconnectDelay = Math.min(this._currentReconnectDelay + 500, 5000);
			this._scheduleReconnect();
			return undefined;
		}
	}

	/**
	 * Schedule a reconnection attempt with exponential backoff.
	 */
	private _scheduleReconnect(): void {
		this._clearReconnectTimeout();

		if (this._maxRetryTime !== undefined && this._retryStartTime !== undefined) {
			if (Date.now() - this._retryStartTime >= this._maxRetryTime) {
				this.onConnectError(new Error('Max retry time exceeded'));
				return;
			}
		}

		this.debugMessage(`Scheduling reconnection in ${this._currentReconnectDelay}ms`);

		this._reconnectTimeout = setTimeout(async () => {
			if (this._persist && !this._manualDisconnect) {
				this.debugMessage('Attempting to reconnect...');
				await this._attemptConnection();
			}
		}, this._currentReconnectDelay);
	}

	/**
	 * Check if the client is currently connected to the RocketRide server.
	 */
	isConnected(): boolean {
		return this._transport?.isConnected() || false;
	}

	/**
	 * Connect to the RocketRide server and authenticate in a single call.
	 *
	 * Sends the credential as the first DAP message and returns the full
	 * ConnectResult (user identity + organizations + teams) on success.
	 *
	 * If `credential` is omitted, falls back to the `ROCKETRIDE_APIKEY` env var.
	 *
	 * In persist mode, enables automatic reconnection on disconnect. After the
	 * first successful connect the stored `userToken` is replayed automatically.
	 *
	 * @param credential - API key / Zitadel access_token / rr_ user token / PKCE code object.
	 * @param options - Optional overrides: uri and/or timeout.
	 */
	async connect(credential?: string | { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult> {
		// Encode PKCE code exchange as cd_<base64(JSON)>
		// Fallback chain for the credential:
		//   1. explicit `credential` arg (string or PKCE object)
		//   2. ROCKETRIDE_APIKEY from the client's env snapshot
		//   3. previously-configured `this._apikey` (e.g. from the constructor)
		// Keeping #3 in the chain is critical for `new Client({ auth }).connect()`:
		// without it, calling connect() with no arguments wiped the auth back to ''.
		let resolvedCredential: string;
		if (credential && typeof credential === 'object') {
			resolvedCredential = 'cd_' + btoa(JSON.stringify(credential));
		} else {
			resolvedCredential = (credential as string | undefined) ?? this._env['ROCKETRIDE_APIKEY'] ?? this._apikey ?? '';
		}
		this._setAuth(resolvedCredential);

		if (options?.uri !== undefined) {
			this._setUri(options.uri);
		}

		this._manualDisconnect = false;
		this._currentReconnectDelay = 500;
		this._retryStartTime = undefined;

		// If already connected, disconnect first
		if (this.isConnected()) {
			await this._internalDisconnect();
		}

		let result: ConnectResult | undefined;
		if (this._persist) {
			this._clearReconnectTimeout();
			result = await this._attemptConnection(options?.timeout);
		} else {
			const body = await this._internalConnect(options?.timeout);
			result = body as unknown as ConnectResult;
			this._connectResult = result;
			// Store userToken for reconnect in persist mode
			if (result?.userToken) {
				this._apikey = result.userToken;
			}
		}

		return result ?? ({} as ConnectResult);
	}

	/**
	 * Get the ConnectResult from the last successful connect().
	 * Returns undefined if not connected or not yet authenticated.
	 */
	getAccountInfo(): ConnectResult | undefined {
		return this._connectResult;
	}

	/**
	 * Returns the ID of the user's primary organization.
	 *
	 * Currently uses `organizations[0]` since multi-org is not yet implemented.
	 * When multi-org ships, this will return the active org based on session context.
	 *
	 * @returns The org UUID, or undefined if not authenticated or no org exists.
	 */
	getOrgId(): string | undefined {
		return this._connectResult?.organizations?.[0]?.id;
	}

	/**
	 * Disconnect from the RocketRide server and stop automatic reconnection.
	 *
	 * Should be called when finished with the client to clean up resources.
	 */
	async disconnect(): Promise<void> {
		this._manualDisconnect = true;
		this._connectResult = undefined;
		this._clearReconnectTimeout();

		if (this._transport && this.isConnected()) {
			await this._internalDisconnect();
		}
	}

	/**
	 * Update the environment variables used for pipeline substitution.
	 *
	 * The env dictionary is used by {@link use} and {@link validate} to replace
	 * `${ROCKETRIDE_*}` placeholders in pipeline configurations. Call this
	 * whenever the user's `.env` settings change so subsequent pipeline
	 * executions pick up the new values without reconnecting.
	 */
	setEnv(env: Record<string, string>): void {
		this._env = { ...env };
	}

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
	 * Substitute environment variables in a string.
	 * Replaces ${ROCKETRIDE_*} patterns with values from client's env dictionary.
	 * If variable is not found, leaves it unchanged.
	 */
	private substituteEnvVars(value: string): string {
		// Match ${ROCKETRIDE_*} patterns
		return value.replace(/\$\{(ROCKETRIDE_[^}]+)\}/g, (match, varName) => {
			// Check if variable exists in client's env
			if (varName in this._env) {
				return String(this._env[varName]);
			}
			// If not found, leave as is
			return match;
		});
	}

	/**
	 * Recursively process an object/array to substitute environment variables.
	 * Only processes string values, leaving other types unchanged.
	 */
	private processEnvSubstitution(obj: unknown): unknown {
		if (typeof obj === 'string') {
			// If it's a string, perform substitution
			return this.substituteEnvVars(obj);
		} else if (Array.isArray(obj)) {
			// If it's an array, process each element
			return obj.map((item) => this.processEnvSubstitution(item));
		} else if (obj !== null && typeof obj === 'object') {
			// If it's an object, process each property
			const result: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(obj)) {
				result[key] = this.processEnvSubstitution(value);
			}
			return result;
		}
		// For other types (number, boolean, null), return as is
		return obj;
	}

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
		} = {}
	): Promise<Record<string, unknown> & { token: string }> {
		const { token, filepath, pipeline, source, threads, useExisting, args, ttl, pipelineTraceLevel, name } = options;

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
		let processedConfig = JSON.parse(JSON.stringify(pipelineConfig));

		// Perform environment variable substitution on the pipeline configuration
		processedConfig = this.processEnvSubstitution(processedConfig);

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
		// Derive display name from filepath if not explicitly provided
		const effectiveName = name ?? (filepath ? filepath.replace(/^.*[\\/]/, '').replace(/\.pipe(?:\.json)?$/, '') : undefined);
		if (effectiveName !== undefined) {
			arguments_.name = effectiveName;
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
				{ token: '*' }
			);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.debugMessage(`Pipeline restart failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}
	}

	/**
	 * Get the current status of a running pipeline.
	 */
	async getTaskStatus(token: string): Promise<TASK_STATUS> {
		try {
			return await this.call<TASK_STATUS>('rrext_get_task_status', undefined, { token });
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

			// Create pipe instance
			const pipe = await this.pipe(token, objinfo, 'application/rocketride-question', 'chat', onSSE);

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
	 * Handle connected events from the RocketRide server.
	 */
	async onConnected(connectionInfo: string): Promise<void> {
		this._manualDisconnect = false;
		this._didNotifyConnected = true;
		this._clearReconnectTimeout();
		this._currentReconnectDelay = 500;
		this._retryStartTime = undefined;

		// Resubscribe all monitor subscriptions after reconnect
		await this._resubscribeAllMonitors();

		// Call user-provided event handler if available
		if (this._callerOnConnected) {
			try {
				await this._callerOnConnected(connectionInfo);
			} catch (error) {
				// Log errors but don't let user code break the connection
				this.debugMessage(`Error in user onConnected handler for ${connectionInfo}: ${error}`);
			}
		}

		await super.onConnected(connectionInfo);
	}

	/**
	 * Handle disconnected events from the RocketRide server.
	 * Only invokes the user's onDisconnected if onConnected had previously been called
	 * (so "disconnect without ever connecting" does not fire the user callback).
	 */
	async onDisconnected(reason: string, hasError: boolean): Promise<void> {
		// Transport is gone — clear it so the next _internalConnect always creates a fresh one
		this._transport = undefined;
		this._connectResult = undefined;

		if (this._didNotifyConnected) {
			this._didNotifyConnected = false;

			if (this._callerOnDisconnected) {
				try {
					await this._callerOnDisconnected(reason, hasError);
				} catch (error) {
					// Log errors but don't let user code break the connection
					this.debugMessage(`Error in user onDisconnected handler for ${reason}: ${error}`);
				}
			}

			// Chain to parent to clear pending requests
			await super.onDisconnected(reason, hasError);
		}

		// Schedule reconnection if persist is enabled and not a manual disconnect
		if (this._persist && !this._manualDisconnect) {
			this._scheduleReconnect();
		}
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
	// ACCOUNT & BILLING NAMESPACES
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
}

export { RocketRideClient as default };
