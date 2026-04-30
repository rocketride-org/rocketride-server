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

/**
 * Type definitions for RocketRide client configuration and DAP communication.
 *
 * This module defines the core types used for client-server communication
 * including DAP messages, callbacks, configuration options, and transport interfaces.
 */

import { ConnectionException } from '../exceptions/index.js';

/**
 * Stack trace information for errors.
 *
 * Carries source-location metadata returned by the server when a server-side
 * error includes a traceback, enabling developers to pinpoint the failure
 * inside pipeline node code.
 */
export interface TraceInfo {
	/** File path where the error occurred */
	file: string;

	/** Line number where the error occurred */
	lineno: number;
}

/**
 * A single DAP (Debug Adapter Protocol) message exchanged between the client
 * and the RocketRide server.
 *
 * All communication on the WebSocket uses this envelope. The `type` field
 * discriminates between the three roles a message can play:
 * - `request`  — client → server command invocation
 * - `response` — server → client result for a prior request
 * - `event`    — server → client unsolicited notification
 */
export interface DAPMessage {
	/** Message type: request from client, response from server, or event notification */
	type: 'request' | 'response' | 'event';

	/** Unique sequence number for message correlation and ordering */
	seq: number;

	/** Command name for requests (e.g., 'execute', 'terminate', 'rrext_ping') */
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
 *
 * Invoked once the WebSocket is open AND the server has confirmed the
 * authentication handshake. `connectionInfo` is an optional human-readable
 * string describing the remote endpoint.
 */
export type ConnectCallback = (connectionInfo?: string) => Promise<void>;

/**
 * Callback function for disconnection events.
 *
 * Invoked whenever the connection closes, whether gracefully or due to an
 * error. `reason` is a human-readable description and `hasError` is true
 * when the closure was caused by an error rather than a clean shutdown.
 */
export type DisconnectCallback = (reason?: string, hasError?: boolean) => Promise<void>;

/**
 * Callback when a connection attempt fails (e.g. auth or pipeline not ready).
 * Used in persist mode to inform the UI while the client keeps retrying.
 *
 * The callback receives a `ConnectionException` (rather than a generic Error)
 * so the caller can inspect structured error details such as status codes
 * returned by the server.
 */
export type ConnectErrorCallback = (error: ConnectionException) => void | Promise<void>;

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

	/** Friendly client name sent during auth (e.g. "VS Code", "Cursor") */
	clientName?: string;

	/** Client version sent during auth (e.g. "0.9.4") */
	clientVersion?: string;

	/**
	 * Optional trace callback invoked at the start and end of every `call()`.
	 * Use for logging, debugging, or telemetry.
	 *
	 * @param traceType - 0 = request (before send), 1 = success (response), 2 = error
	 * @param payload   - The trace data: command, args, and (for success/error) the result or error message.
	 */
	onTrace?: (traceType: TraceType, message: DAPMessage) => void;
}

// =============================================================================
// TRACE TYPES
// =============================================================================

/** Discriminator for the three trace event types. */
export enum TraceType {
	/** Emitted before the DAP request is sent. */
	Request = 0,
	/** Emitted when the DAP request succeeds. */
	Success = 1,
	/** Emitted when the DAP request fails. */
	Error = 2,
}

// =============================================================================
// CONNECT RESULT TYPES
// =============================================================================

/**
 * Describes a team within an organisation that the authenticated user belongs to.
 *
 * Teams are the finest-grained unit of access control. Each team carries a set
 * of permission strings that govern which server operations are available to
 * members of that team.
 */
export interface TeamInfo {
	/** Unique identifier of the team (UUID or short slug) */
	id: string;

	/** Display name of the team shown in dashboards and logs */
	name: string;

	/**
	 * Permission strings granted to this team.
	 * Examples: `'task.execute'`, `'task.monitor'`, `'store.read'`.
	 */
	permissions: string[];
}

/**
 * Describes an organisation the authenticated user is a member of.
 *
 * Organisations group users and teams for billing and access management.
 * A user may belong to multiple organisations; each carries its own permission
 * set at the organisation level plus a list of contained teams.
 */
export interface OrgInfo {
	/** Unique identifier of the organisation (UUID or short slug) */
	id: string;

	/** Display name of the organisation */
	name: string;

	/**
	 * Organisation-level permission strings granted to the authenticated user.
	 * These apply across all teams within the organisation.
	 */
	permissions: string[];

	/**
	 * Teams within this organisation that the user is a member of.
	 * Each entry includes team-scoped permissions.
	 */
	teams: TeamInfo[];
}

/**
 * Full identity and authorisation payload returned by the server after a
 * successful authentication handshake (`auth` command).
 *
 * The client caches this object and re-emits it whenever the server pushes
 * an `apaext_account` event (e.g. after a plan change). The `userToken`
 * field is used for subsequent reconnects in persist mode.
 */
export interface ConnectResult {
	/**
	 * Short-lived RocketRide session token (`rr_…`) that can be replayed on
	 * reconnect without requiring the original API key or PKCE exchange again.
	 */
	userToken: string;

	/** Unique identifier of the authenticated user (UUID) */
	userId: string;

	/** Full display name of the user (e.g. "Jane Smith") */
	displayName: string;

	/** User's given (first) name */
	givenName: string;

	/** User's family (last) name */
	familyName: string;

	/** Username / login handle (not necessarily unique across providers) */
	preferredUsername: string;

	/** Primary email address of the user */
	email: string;

	/** Whether the email address has been verified by the identity provider */
	emailVerified: boolean;

	/** Primary phone number of the user (E.164 format where available) */
	phoneNumber: string;

	/** Whether the phone number has been verified by the identity provider */
	phoneNumberVerified: boolean;

	/** BCP-47 locale tag (e.g. "en-US") representing the user's preferred locale */
	locale: string;

	/**
	 * ID of the team that should be used by default for operations that do not
	 * explicitly specify a team context.
	 */
	defaultTeam: string;

	/**
	 * List of organisations the authenticated user belongs to, each with
	 * its own permission set and nested team memberships.
	 */
	organizations: OrgInfo[];

	/**
	 * App IDs the user's primary organisation is currently subscribed to.
	 * Only includes subscriptions with status `active`, `trialing`, or `past_due`.
	 * Empty for free-tier orgs with no paid app subscriptions.
	 */
	subscribedApps: string[];

	/**
	 * Server capability tags describing the account provider in use.
	 * OSS servers report `['oss']`; SaaS servers report `['saas']`.
	 */
	capabilities: string[];
}

/**
 * Server metadata returned by the pre-auth info probe.
 *
 * Obtained via {@link RocketRideClient.getServerInfo} which sends an
 * `auth` request with `infoOnly: true`. The server responds without
 * requiring credentials.
 */
export interface ServerInfoResult {
	/** Server engine version string. */
	version: string;

	/** Capability tags: `['oss']` for open-source, `['saas']` for cloud. */
	capabilities: string[];

	/** Server platform (e.g. `'linux'`, `'win32'`, `'darwin'`). */
	platform?: string;
}
