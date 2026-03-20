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
import { DAPMessage, EventCallback, RocketRideClientConfig, ConnectCallback, DisconnectCallback, ConnectErrorCallback } from './types/index.js';
import { TASK_STATUS, UPLOAD_RESULT, PIPELINE_RESULT, PipelineConfig } from './types/index.js';
import { CONST_DEFAULT_WEB_CLOUD, CONST_DEFAULT_WEB_PROTOCOL, CONST_DEFAULT_WEB_PORT } from './constants.js';
import { Question } from './schema/Question.js';
import { AuthenticationException } from './exceptions/index.js';

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
	 * @throws Error if the pipe is already opened or if the pipeline is not running
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
			throw new Error(response.message || 'Your pipeline is not currently running.');
		}

		this._pipeId = response.body?.pipe_id as number | undefined;
		this._opened = true;

		// If an SSE callback was provided, subscribe and register for this pipe
		if (this._onSSE !== undefined && this._pipeId !== undefined) {
			await this._client.setEvents(this._token, ['SSE'], this._pipeId);
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
	 * @throws Error if the pipe is not opened, buffer is invalid, or write fails
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
			throw new Error(response.message || 'Failed to write to pipe');
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
	 * @throws Error if closing the pipe fails
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
				throw new Error(response.message || 'Failed to close pipe');
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
	private _currentReconnectDelay: number = 250;

	/** True after onConnected has been invoked; used to only invoke onDisconnected when we had a connection. */
	private _didNotifyConnected: boolean = false;

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

		const { auth = config.auth || clientEnv.ROCKETRIDE_APIKEY, uri = config.uri || clientEnv.ROCKETRIDE_URI || CONST_DEFAULT_WEB_CLOUD, onEvent, onConnected, onDisconnected, onConnectError, persist, maxRetryTime, module } = config;

		// Create unique client identifier
		const clientName = module || `CLIENT-${clientId++}`;

		// Initialize the DAPClient without a transport; transport is created in _internalConnect (CONNECTION_LOGIC.md §3)
		super(clientName, undefined, config);

		// Store connection details and environment
		this._setUri(uri);
		this._setAuth(auth);
		this._env = clientEnv;

		// Set up callbacks if provided
		if (onEvent) this._callerOnEvent = onEvent;
		if (onConnected) this._callerOnConnected = onConnected;
		if (onDisconnected) this._callerOnDisconnected = onDisconnected;
		if (onConnectError) this._callerOnConnectError = onConnectError;

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

			if (!url.port && !url.hostname.includes('rocketride.ai')) {
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
	 */
	private async _internalConnect(timeout?: number): Promise<void> {
		if (!this._transport) {
			const transport = new TransportWebSocket(this._uri, this._apikey!);
			this._bindTransport(transport);
		}
		await super.connect(timeout);
	}

	/**
	 * Single place for physical disconnect. Closes the transport directly,
	 * which triggers onDisconnected via the transport callback.
	 */
	private async _internalDisconnect(reason?: string, hasError?: boolean): Promise<void> {
		if (!this._transport) return;
		await this._transport.disconnect(reason, hasError);
	}

	/**
	 * Try to connect; on auth error notify and stop; on other error notify and
	 * reschedule with exponential backoff. Used by persist-mode connect() and
	 * by the reconnect timer.
	 */
	private async _attemptConnection(timeout?: number): Promise<void> {
		try {
			await this._internalConnect(timeout);
			this._reconnectTimeout = undefined;
			this.debugMessage('Connection successful');
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.debugMessage(`Connection failed: ${err}`);
			await this.onConnectError(err);

			if (error instanceof AuthenticationException) {
				return;
			}

			if (this._retryStartTime === undefined) {
				this._retryStartTime = Date.now();
			}

			if (this._maxRetryTime !== undefined) {
				if (Date.now() - this._retryStartTime >= this._maxRetryTime) {
					return;
				}
			}

			this._currentReconnectDelay = Math.min(this._currentReconnectDelay * 2, 2500);
			this._scheduleReconnect();
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
	 * Connect to the RocketRide server.
	 *
	 * Must be called before executing pipelines or other operations.
	 * In persist mode, enables automatic reconnection on disconnect and on initial failure
	 * (calls onConnectError on each failed attempt and keeps retrying).
	 * @param options - Optional timeout (number) or connection parameters object with uri, auth, and timeout.
	 */
	async connect(options?: number | { uri?: string; auth?: string; timeout?: number }): Promise<void> {
		let uri: string | undefined;
		let auth: string | undefined;
		let timeout: number | undefined;

		if (typeof options === 'number') {
			timeout = options;
		} else if (options) {
			({ uri, auth, timeout } = options);
		}

		// Apply optional overrides so they're used for this connect
		if (uri !== undefined) {
			this._setUri(uri);
		}
		if (auth !== undefined) {
			this._setAuth(auth);
		}

		this._manualDisconnect = false;
		this._currentReconnectDelay = 250;
		this._retryStartTime = undefined;

		// If already connected, disconnect first without setting _manualDisconnect
		if (this.isConnected()) {
			await this._internalDisconnect();
		}

		if (this._persist) {
			this._clearReconnectTimeout();
			await this._attemptConnection(timeout);
		} else {
			await this._internalConnect(timeout);
		}
	}

	/**
	 * Disconnect from the RocketRide server and stop automatic reconnection.
	 *
	 * Should be called when finished with the client to clean up resources.
	 */
	async disconnect(): Promise<void> {
		this._manualDisconnect = true;
		this._clearReconnectTimeout();

		if (this._transport && this.isConnected()) {
			await this._internalDisconnect();
		}
	}

	/**
	 * Update server URI and/or auth at runtime. If currently connected,
	 * disconnects and reconnects with the new params. In persist mode,
	 * reconnection is scheduled only if we were connected.
	 */
	async setConnectionParams(options: { uri?: string; auth?: string }): Promise<void> {
		if (options.uri !== undefined) {
			this._setUri(options.uri);
		}
		if (options.auth !== undefined) {
			this._setAuth(options.auth);
		}

		const wasAlreadyConnected = this.isConnected();

		this._manualDisconnect = true;
		this._clearReconnectTimeout();

		if (wasAlreadyConnected) {
			await this._internalDisconnect();
		}

		// Destroy transport so next connect() creates a new one with updated uri/auth (CONNECTION_LOGIC.md §2c)
		if (options.uri !== undefined || options.auth !== undefined) {
			this._transport = undefined;
		}

		if (this._persist && wasAlreadyConnected) {
			this._manualDisconnect = false;
			this._scheduleReconnect();
		} else if (wasAlreadyConnected) {
			this._manualDisconnect = false;
			await this._internalConnect();
		} else {
			this._manualDisconnect = false;
		}
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
		// Build ping request
		const request = this.buildRequest('rrext_ping', { token });

		// Send to server and wait for response
		const response = await this.request(request);

		// Check if ping failed
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Ping failed';
			throw new Error(`Ping failed: ${errorMsg}`);
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
	async validate(options: { pipeline: PipelineConfig | Record<string, unknown>; source?: string }): Promise<Record<string, unknown>> {
		const { pipeline, source } = options;
		const arguments_: Record<string, unknown> = { pipeline };
		if (source !== undefined) {
			arguments_.source = source;
		}
		const request = this.buildRequest('rrext_validate', {
			arguments: arguments_,
		});
		const response = await this.request(request);
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Validation failed';
			throw new Error(`Pipeline validation failed: ${errorMsg}`);
		}
		return response.body || {};
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
		} = {}
	): Promise<Record<string, unknown> & { token: string }> {
		const { token, filepath, pipeline, source, threads, useExisting, args, ttl, pipelineTraceLevel } = options;

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

		// Send execution request to server
		const request = this.buildRequest('execute', { arguments: arguments_ });
		const response = await this.request(request);

		// Check for execution errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown execution error';
			this.debugMessage(`Pipeline execution failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and validate response
		const responseBody = response.body || {};
		const taskToken = responseBody.token as string;

		if (!taskToken) {
			throw new Error('Server did not return a task token in successful response');
		}

		this.debugMessage(`Pipeline execution started successfully, task token: ${taskToken}`);

		// Type assertion to ensure token is present
		return responseBody as Record<string, unknown> & { token: string };
	}

	/**
	 * Terminate a running pipeline.
	 */
	async terminate(token: string): Promise<void> {
		// Send termination request
		const request = this.buildRequest('terminate', { token });
		const response = await this.request(request);

		// Check for termination errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown termination error';
			this.debugMessage(`Pipeline termination failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}
	}

	/**
	 * Get the current status of a running pipeline.
	 */
	async getTaskStatus(token: string): Promise<TASK_STATUS> {
		// Send status request
		const request = this.buildRequest('rrext_get_task_status', { token });
		const response = await this.request(request);

		// Check for status retrieval errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown status retrieval error';
			this.debugMessage(`Pipeline status retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Return status information
		return (response.body as unknown as TASK_STATUS) || {};
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
		token: string,
		onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>
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
				pipe = await this.pipe(token, this._objinfoWithSize({ name: file.name, ...objinfo }, fileSize), finalMimetype, undefined, onSSE);
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
				await this._callerOnConnectError(error instanceof Error ? error.message : String(error));
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
		this._currentReconnectDelay = 250;
		this._retryStartTime = undefined;

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
	 */
	async setEvents(token: string, eventTypes: string[], pipeId?: number): Promise<void> {
		// Build event subscription request
		const args: Record<string, unknown> = { types: eventTypes };
		if (pipeId !== undefined) args.pipeId = pipeId;
		const request = this.buildRequest('rrext_monitor', {
			arguments: args,
			token,
		});

		// Send to server
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Event subscription failed';
			throw new Error(errorMsg);
		}
	}

	// ============================================================================
	// PROJECT STORAGE MANAGEMENT
	// ============================================================================

	/**
	 * Save or update a project pipeline.
	 *
	 * Stores a project pipeline configuration on the server. If the project
	 * already exists, it will be updated. Use expectedVersion to ensure
	 * you're updating the version you expect (prevents conflicts).
	 *
	 * @param options - Save project options
	 * @param options.projectId - Unique identifier for the project
	 * @param options.pipeline - Pipeline configuration object
	 * @param options.expectedVersion - Expected current version for atomic updates (optional)
	 * @returns Promise resolving to save result with success status, projectId, and new version
	 * @throws Error if save fails due to version mismatch, storage error, or invalid input
	 *
	 * @example
	 * ```typescript
	 * // Save a new project
	 * const result = await client.saveProject({
	 *   projectId: 'proj-123',
	 *   pipeline: {
	 *     name: 'Data Processor',
	 *     source: 'source_1',
	 *     components: [...]
	 *   }
	 * });
	 * console.log(`Saved version: ${result.version}`);
	 *
	 * // Update existing project with version check
	 * const existing = await client.getProject({ projectId: 'proj-123' });
	 * existing.name = 'Updated Name';
	 * const updated = await client.saveProject({
	 *   projectId: 'proj-123',
	 *   pipeline: existing,
	 *   expectedVersion: existing.version
	 * });
	 * ```
	 */
	async saveProject(options: { projectId: string; pipeline: Record<string, any>; expectedVersion?: string }): Promise<{
		success: boolean;
		project_id: string;
		version: string;
	}> {
		const { projectId, pipeline, expectedVersion } = options;

		// Validate inputs
		if (!projectId) {
			throw new Error('projectId is required');
		}
		if (!pipeline || typeof pipeline !== 'object') {
			throw new Error('pipeline must be a non-empty object');
		}

		// Build request arguments
		const args: any = {
			subcommand: 'save_project',
			projectId,
			pipeline,
		};

		// Add optional version for atomic updates
		if (expectedVersion !== undefined) {
			args.expectedVersion = expectedVersion;
		}

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error saving project';
			this.debugMessage(`Project save failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Project saved successfully: ${projectId}, version: ${response.body?.version}`);
		return response.body as any;
	}

	/**
	 * Retrieve a project by its ID.
	 *
	 * Fetches the complete pipeline configuration and current version for
	 * the specified project. Use this before updating to get the current
	 * version for atomic updates.
	 *
	 * @param options - Get project options
	 * @param options.projectId - Unique identifier of the project to retrieve
	 * @returns Promise resolving to project data with success status, pipeline, and version
	 * @throws Error if project doesn't exist or retrieval fails
	 *
	 * @example
	 * ```typescript
	 * // Get a project
	 * try {
	 *   const project = await client.getProject({ projectId: 'proj-123' });
	 *   console.log(`Project: ${project.name}`);
	 *   console.log(`Version: ${project.version}`);
	 * } catch (error) {
	 *   if (error.message.includes('NOT_FOUND')) {
	 *     console.log("Project doesn't exist");
	 *   }
	 * }
	 *
	 * // Before updating - get current version
	 * const project = await client.getProject({ projectId: 'proj-123' });
	 * project.name = 'Updated';
	 * await client.saveProject({
	 *   projectId: 'proj-123',
	 *   pipeline: project,
	 *   expectedVersion: project.version
	 * });
	 * ```
	 */
	async getProject(options: { projectId: string }): Promise<{
		success: boolean;
		pipeline: Record<string, any>;
		version: string;
	}> {
		const { projectId } = options;

		// Validate inputs
		if (!projectId) {
			throw new Error('projectId is required');
		}

		// Build request
		const args = {
			subcommand: 'get_project',
			projectId,
		};

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error retrieving project';
			this.debugMessage(`Project retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Project retrieved successfully: ${projectId}`);
		return response.body as any;
	}

	/**
	 * Delete a project by its ID.
	 *
	 * Permanently removes a project from storage. Optionally verify the
	 * version before deletion to ensure you're deleting the version you
	 * expect (prevents accidental deletion of modified projects).
	 *
	 * @param options - Delete project options
	 * @param options.projectId - Unique identifier of the project to delete
	 * @param options.expectedVersion - Expected current version for atomic deletion (required)
	 * @returns Promise resolving to deletion result with success status and message
	 * @throws Error if project doesn't exist, version mismatch, or deletion fails
	 *
	 * @example
	 * ```typescript
	 * // Safe deletion with version check
	 * const project = await client.getProject({ projectId: 'proj-123' });
	 * try {
	 *   const result = await client.deleteProject({
	 *     projectId: 'proj-123',
	 *     expectedVersion: project.version
	 *   });
	 *   console.log('Project deleted successfully');
	 * } catch (error) {
	 *   if (error.message.includes('CONFLICT')) {
	 *     console.log('Project was modified, deletion cancelled');
	 *   }
	 * }
	 * ```
	 */
	async deleteProject(options: { projectId: string; expectedVersion?: string }): Promise<{
		success: boolean;
		message: string;
	}> {
		const { projectId, expectedVersion } = options;

		// Validate inputs
		if (!projectId) {
			throw new Error('projectId is required');
		}

		// Build request
		const args: any = {
			subcommand: 'delete_project',
			projectId,
		};

		// Add optional version for atomic deletion
		if (expectedVersion !== undefined) {
			args.expectedVersion = expectedVersion;
		}

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error deleting project';
			this.debugMessage(`Project deletion failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Project deleted successfully: ${projectId}`);
		return response.body as any;
	}

	/**
	 * List all projects for the current user.
	 *
	 * Retrieves a summary of all projects stored for the authenticated user.
	 * Each project summary includes the ID, name, list of data sources, and total component count.
	 *
	 * @returns Promise resolving to list result with success status, projects array, and count
	 * @throws Error if retrieval fails
	 *
	 * @example
	 * ```typescript
	 * // List all projects
	 * const result = await client.getAllProjects();
	 * console.log(`Found ${result.count} projects:`);
	 * for (const project of result.projects) {
	 *   console.log(`- ${project.id}: ${project.name} (${project.totalComponents} components)`);
	 *   for (const source of project.sources) {
	 *     console.log(`  * ${source.name} (${source.provider})`);
	 *   }
	 * }
	 *
	 * // Find specific project
	 * const result = await client.getAllProjects();
	 * const myProject = result.projects.find(p => p.id === 'proj-123');
	 * ```
	 */
	async getAllProjects(): Promise<{
		success: boolean;
		projects: Array<{
			id: string;
			name: string;
			sources: Array<{
				id: string;
				provider: string;
				name: string;
			}>;
			totalComponents: number;
		}>;
		count: number;
	}> {
		// Build request
		const args = {
			subcommand: 'get_all_projects',
		};

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error listing projects';
			this.debugMessage(`Project list retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		const projectCount = response.body?.count || 0;
		this.debugMessage(`Projects retrieved successfully: ${projectCount} projects`);
		return response.body as any;
	}

	// ============================================================================
	// TEMPLATE STORAGE MANAGEMENT (System-wide templates)
	// ============================================================================

	/**
	 * Save or update a template pipeline.
	 *
	 * Stores a template pipeline configuration on the server. Templates are system-wide
	 * and accessible to all users. If the template already exists, it will be updated.
	 * Use expectedVersion to ensure you're updating the version you expect.
	 *
	 * @param options - Save template options
	 * @param options.templateId - Unique identifier for the template
	 * @param options.pipeline - Pipeline configuration object
	 * @param options.expectedVersion - Expected current version for atomic updates (optional)
	 * @returns Promise resolving to save result with success status, templateId, and new version
	 * @throws Error if save fails due to version mismatch, storage error, or invalid input
	 */
	async saveTemplate(options: { templateId: string; pipeline: Record<string, any>; expectedVersion?: string }): Promise<{
		success: boolean;
		template_id: string;
		version: string;
	}> {
		const { templateId, pipeline, expectedVersion } = options;

		// Validate inputs
		if (!templateId) {
			throw new Error('templateId is required');
		}
		if (!pipeline || typeof pipeline !== 'object') {
			throw new Error('pipeline must be a non-empty object');
		}

		// Build request arguments
		const args: any = {
			subcommand: 'save_template',
			templateId,
			pipeline,
		};

		// Add optional version for atomic updates
		if (expectedVersion !== undefined) {
			args.expectedVersion = expectedVersion;
		}

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error saving template';
			this.debugMessage(`Template save failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Template saved successfully: ${templateId}, version: ${response.body?.version}`);
		return response.body as any;
	}

	/**
	 * Retrieve a template by its ID.
	 */
	async getTemplate(options: { templateId: string }): Promise<{
		success: boolean;
		pipeline: Record<string, any>;
		version: string;
	}> {
		const { templateId } = options;

		// Validate inputs
		if (!templateId) {
			throw new Error('templateId is required');
		}

		// Build request
		const args = {
			subcommand: 'get_template',
			templateId,
		};

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error retrieving template';
			this.debugMessage(`Template retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Template retrieved successfully: ${templateId}`);
		return response.body as any;
	}

	/**
	 * Delete a template by its ID.
	 */
	async deleteTemplate(options: { templateId: string; expectedVersion?: string }): Promise<{
		success: boolean;
		message: string;
	}> {
		const { templateId, expectedVersion } = options;

		// Validate inputs
		if (!templateId) {
			throw new Error('templateId is required');
		}

		// Build request
		const args: any = {
			subcommand: 'delete_template',
			templateId,
		};

		// Add optional version for atomic deletion
		if (expectedVersion !== undefined) {
			args.expectedVersion = expectedVersion;
		}

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error deleting template';
			this.debugMessage(`Template deletion failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Template deleted successfully: ${templateId}`);
		return response.body as any;
	}

	/**
	 * List all templates.
	 */
	async getAllTemplates(): Promise<{
		success: boolean;
		templates: Array<{
			id: string;
			name: string;
			sources: Array<{
				id: string;
				provider: string;
				name: string;
			}>;
			totalComponents: number;
		}>;
		count: number;
	}> {
		// Build request
		const args = {
			subcommand: 'get_all_templates',
		};

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error listing templates';
			this.debugMessage(`Template list retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		const templateCount = response.body?.count || 0;
		this.debugMessage(`Templates retrieved successfully: ${templateCount} templates`);
		return response.body as any;
	}

	// ============================================================================
	// LOG STORAGE MANAGEMENT (Per-project log files for historical tracking)
	// ============================================================================

	/**
	 * Save a log file for a source run.
	 */
	async saveLog(options: { projectId: string; source: string; contents: Record<string, any> }): Promise<{
		success: boolean;
		filename: string;
	}> {
		const { projectId, source, contents } = options;

		// Validate inputs
		if (!projectId) {
			throw new Error('projectId is required');
		}
		if (!source) {
			throw new Error('source is required');
		}
		if (!contents || typeof contents !== 'object') {
			throw new Error('contents must be a non-empty object');
		}

		// Build request arguments
		const args = {
			subcommand: 'save_log',
			projectId,
			source,
			contents,
		};

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error saving log';
			this.debugMessage(`Log save failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Log saved successfully: ${response.body?.filename}`);
		return response.body as any;
	}

	/**
	 * Get a log file by source name and start time.
	 */
	async getLog(options: { projectId: string; source: string; startTime: number }): Promise<{
		success: boolean;
		contents: Record<string, any>;
	}> {
		const { projectId, source, startTime } = options;

		// Validate inputs
		if (!projectId) {
			throw new Error('projectId is required');
		}
		if (!source) {
			throw new Error('source is required');
		}
		if (startTime === undefined || startTime === null) {
			throw new Error('startTime is required');
		}

		// Build request
		const args = {
			subcommand: 'get_log',
			projectId,
			source,
			startTime,
		};

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error retrieving log';
			this.debugMessage(`Log retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		this.debugMessage(`Log retrieved successfully: ${projectId}/${source}`);
		return response.body as any;
	}

	/**
	 * List log files for a project.
	 */
	async listLogs(options: { projectId: string; source?: string; page?: number }): Promise<{
		success: boolean;
		logs: string[];
		count: number;
		total_count: number;
		page: number;
		total_pages: number;
	}> {
		const { projectId, source, page } = options;

		// Validate inputs
		if (!projectId) {
			throw new Error('projectId is required');
		}

		// Build request
		const args: any = {
			subcommand: 'list_logs',
			projectId,
		};

		// Add optional parameters
		if (source !== undefined) {
			args.source = source;
		}
		if (page !== undefined) {
			args.page = page;
		}

		// Send request to server
		const request = this.buildRequest('rrext_store', { arguments: args });
		const response = await this.request(request);

		// Check for errors
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Unknown error listing logs';
			this.debugMessage(`Log list retrieval failed: ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Extract and return response
		const logCount = response.body?.total_count || 0;
		this.debugMessage(`Logs retrieved successfully: ${logCount} logs`);
		return response.body as any;
	}

	// ============================================================================
	// RAW REQUEST METHOD
	// ============================================================================

	/**
	 * Send an arbitrary DAP command with command name, arguments, and optional token.
	 *
	 * This is a convenience method for callers that don't want to construct
	 * full DAPMessage objects. It builds the request internally and delegates
	 * to the underlying request() method.
	 *
	 * @param command - The DAP command name (e.g., 'rrext_services', 'rrext_monitor')
	 * @param args - Optional arguments for the command
	 * @param token - Optional task/session token
	 * @param timeout - Optional per-request timeout in ms
	 * @returns The response DAPMessage from the server
	 */
	async dapRequest(command: string, args?: Record<string, unknown>, token?: string, timeout?: number): Promise<DAPMessage> {
		const message = this.buildRequest(command, {
			arguments: args,
			token,
		});
		return await this.request(message, timeout);
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
			await client.connect();
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
	async getServices(): Promise<Record<string, unknown>> {
		// Build services request (no service argument = get all)
		const request = this.buildRequest('rrext_services', {});

		// Send to server and wait for response
		const response = await this.request(request);

		// Check if request failed
		if (this.didFail(response)) {
			const errorMsg = response.message || 'Failed to retrieve services';
			throw new Error(`Failed to retrieve services: ${errorMsg}`);
		}

		// Return the body containing all service definitions
		return response.body || {};
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
	async getService(service: string): Promise<Record<string, unknown> | undefined> {
		if (!service) {
			throw new Error('Service name is required');
		}

		// Build services request with specific service name
		const request = this.buildRequest('rrext_services', {
			arguments: { service },
		});

		// Send to server and wait for response
		const response = await this.request(request);

		// Check if request failed
		if (this.didFail(response)) {
			const errorMsg = response.message || `Service '${service}' not found`;
			throw new Error(`Failed to retrieve service '${service}': ${errorMsg}`);
		}

		// Return the body containing the service definition
		return response.body;
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
}

export { RocketRideClient as default };
