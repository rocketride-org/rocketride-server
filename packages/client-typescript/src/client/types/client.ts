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

/**
 * Type definitions for RocketRide client configuration and DAP communication.
 * 
 * This module defines the core types used for client-server communication
 * including DAP messages, callbacks, configuration options, and transport interfaces.
 */

/**
 * Stack trace information for errors.
 */
export interface TraceInfo {
	/** File path where the error occurred */
	file: string;

	/** Line number where the error occurred */
	lineno: number;
}

export interface DAPMessage {
	/** Message type: request from client, response from server, or event notification */
	type: 'request' | 'response' | 'event';

	/** Unique sequence number for message correlation and ordering */
	seq: number;

	/** Command name for requests (e.g., 'execute', 'terminate', 'apaext_ping') */
	command?: string;

	/** Command arguments and parameters */
	arguments?: Record<string, unknown>;

	/** Response body containing results and data */
	body?: Record<string, unknown>;

	/** Success flag for responses - true if operation succeeded */
	success?: boolean;

	/** Error or status message */
	message?: string;

	/** Sequence number of the request this response corresponds to */
	request_seq?: number;

	/** Event type name for event messages */
	event?: string;

	/** Task or pipeline token for operation context */
	token?: string;

	/** Binary or text data payload */
	data?: Uint8Array | string;

	/** Stack trace information for errors */
	trace?: TraceInfo;
}

/**
 * Callback functions for transport layer events and debugging.
 * 
 * These callbacks provide hooks for monitoring transport activity,
 * debugging protocol messages, and handling connection lifecycle events.
 */
export interface TransportCallbacks {
	/** Called when debug messages are generated */
	onDebugMessage?: (message: string) => void;

	/** Called when protocol messages are sent/received for debugging */
	onDebugProtocol?: (message: string) => void;

	/** Called when a message is received from the server */
	onReceive?: (message: DAPMessage) => Promise<void>;

	/** Called when connection is established */
	onConnected?: (connectionInfo?: string) => Promise<void>;

	/** Called when connection is lost or closed */
	onDisconnected?: (reason?: string, hasError?: boolean) => Promise<void>;
}

/**
 * Connection configuration for establishing server connections.
 */
export interface ConnectionInfo {
	/** Server URI (WebSocket endpoint) */
	uri: string;

	/** Authentication token or API key */
	auth?: string;
}

/**
 * Callback function for handling real-time events from the server.
 * 
 * Events include pipeline status updates, processing progress,
 * error notifications, and system alerts.
 */
export type EventCallback = (event: DAPMessage) => Promise<void>;

/**
 * Callback function for connection establishment events.
 */
export type ConnectCallback = (connectionInfo?: string) => Promise<void>;

/**
 * Callback function for disconnection events.
 */
export type DisconnectCallback = (reason?: string, hasError?: boolean) => Promise<void>;

/**
 * Callback when a connection attempt fails (e.g. auth or pipeline not ready).
 * Used in persist mode to inform the UI while the client keeps retrying.
 */
export type ConnectErrorCallback = (message: string) => Promise<void>;

/**
 * Configuration options for creating an RocketRideClient instance.
 * 
 * Provides connection settings, authentication, and event handling
 * configuration for establishing and managing server connections.
 */
export interface RocketRideClientConfig {
	/** API authentication key or token */
	auth?: string;

	/** Server URI (will be converted to WebSocket URI automatically) */
	uri?: string;

	/** 
	 * Environment variables dictionary for configuration and variable substitution.
	 * If not provided, will load from .env file (Node.js only), then fall back to process.env
	 */
	env?: Record<string, string>;

	/** Callback for handling real-time events from server */
	onEvent?: EventCallback;

	/** Callback for connection establishment */
	onConnected?: ConnectCallback;

	/** Callback for disconnection events */
	onDisconnected?: DisconnectCallback;

	/** Callback when a connection attempt fails (persist mode: called on each failure while retrying) */
	onConnectError?: ConnectErrorCallback;

	/** Optional function to output a protocol message */
	onProtocolMessage?: (message: string) => void;

	/** Optional function to output a debug message */
	onDebugMessage?: (message: string) => void;

	/** Maintain the connection */
	persist?: boolean;

	/** Default timeout in ms for individual requests. Default: no timeout. */
	requestTimeout?: number;

	/** Max total time in ms to keep retrying connections. Default: undefined (forever). */
	maxRetryTime?: number;

	/** Client module name for debugging and identification */
	module?: string;
}


