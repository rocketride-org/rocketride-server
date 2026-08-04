// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * types.ts - VS Code Debug Adapter Protocol (DAP) Type Definitions for RocketRide Extension
 * 
 * This module defines TypeScript interfaces that extend the standard VS Code Debug Adapter Protocol
 * to support RocketRide-specific debugging functionality. These types ensure type safety when communicating
 * between the VS Code client, debug adapter, and the external RocketRide debug server.
 * 
 * The Debug Adapter Protocol (DAP) is a standardized protocol for communication between development
 * tools and debuggers. This file extends the base DAP types with RocketRide-specific properties and data structures.
 */

import { DebugProtocol } from '@vscode/debugprotocol';

//=====================================================================================
// BASE GENERIC PROTOCOL TYPES
// 
// These interfaces provide a flexible foundation for the Debug Adapter Protocol
// communication. They define the basic structure for requests, responses, and events
// while allowing for custom argument and body types.
//=====================================================================================

/**
 * Generic arguments interface for protocol messages.
 * Provides a flexible base for all request argument types, allowing any string-keyed properties.
 * This serves as the foundation for more specific argument interfaces.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DAP protocol arguments are inherently open-ended
export interface GenericArguments extends Record<string, any> { }

/**
 * Generic body interface for protocol message responses and events.
 * Provides a flexible base for all response/event body types, allowing any string-keyed properties.
 * This serves as the foundation for more specific body interfaces.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DAP protocol bodies are inherently open-ended
export interface GenericBody extends Record<string, any> { }

/**
 * Base structure for all Debug Adapter Protocol requests.
 * Defines the common properties that all request messages must have.
 */
export interface GenericRequest {
	/** Message type identifier - always 'request' for request messages */
	type: 'request';

	/** The command being requested (e.g., 'launch', 'attach', 'setBreakpoints') */
	command: string;

	/** Command-specific arguments, or undefined if no arguments are needed */
	arguments: GenericArguments | undefined;

	token?: string;
	apikey?: string;

	/** 
	 * Sequence number for message ordering and correlation.
	 * This is managed automatically by the Debug Adapter Protocol implementation.
	 */
	seq?: number;
}

/**
 * Base structure for all Debug Adapter Protocol responses.
 * Defines the common properties that all response messages must have.
 */
export interface GenericResponse {
	/** Message type identifier - always 'response' for response messages */
	type: 'response';

	/** The command this response is answering (may be omitted in some implementations) */
	command?: string;

	/** Whether the request was handled successfully */
	success: boolean;

	/** Response-specific data, or undefined if no data is returned */
	body?: GenericBody | undefined;

	message?: string;
	token?: string;
	apikey?: string;


	/**
	 * Sequence number for this response message.
	 * This is managed automatically by the Debug Adapter Protocol implementation.
	 */
	seq?: number;

	/** 
	 * Sequence number of the request message this response is answering.
	 * This is managed automatically by the Debug Adapter Protocol implementation.
	 */
	request_seq?: number;
}

/**
 * Base structure for all Debug Adapter Protocol events.
 * Events are unsolicited messages sent from the debug adapter to the client.
 */
export interface GenericEvent {
	/** Message type identifier - always 'event' for event messages */
	type: 'event';

	/** The event type being reported (e.g., 'stopped', 'terminated', 'output') */
	event: string;

	/** Event-specific data, or undefined if no data is provided */
	body?: GenericBody | undefined;

	token?: string;
	apikey?: string;

	/** 
	 * Sequence number for this event message.
	 * This is managed automatically by the Debug Adapter Protocol implementation.
	 */
	seq?: number;
}

export type GenericMessage = GenericResponse | GenericEvent;

//=====================================================================================
// LAUNCH OPERATIONS
// 
// Launch operations start a new debugging session by either starting a local engine
// process or connecting to a remote debug server. These types define the configuration
// and response data for launch requests.
//=====================================================================================

/**
 * Launch request arguments specific to the RocketRide debug adapter.
 * 
 * Extends the standard DAP LaunchRequestArguments with RocketRide-specific configuration
 * options for launching pipeline debugging sessions. Supports both local engine launching
 * and connection to remote debug servers.
 */
export interface LaunchRequestArguments extends GenericArguments {
	/**
	 * The file system path to the pipeline file (.pipeline) to debug.
	 * Can be absolute or relative to the workspace root.
	 * If not specified, uses the currently active editor's file.
	 */
	file?: string;

	/**
	 * Optional token identifier for connecting to an existing debug session.
	 * When provided, the adapter will attempt to connect to a session with this token
	 * instead of starting a new pipeline execution.
	 */
	token?: string;

	/**
	 * Additional command-line arguments to pass to the engine process.
	 * These are appended to the engine's startup command and can be used
	 * to configure engine behavior or pass environment-specific settings.
	 * Only applicable when launching a local engine process.
	 */
	args?: string[];

	/**
	 * The complete pipeline definition object to launch.
	 * This contains the pipeline structure, components, and configuration.
	 * Typically populated by parsing the pipeline file specified in the 'file' parameter.
	 * If provided, this takes precedence over the file parameter.
	 */
	pipeline?: Record<string, unknown>;

	/**
	 * Optional source identifier for the pipeline.
	 * Used to distinguish between multiple pipelines or data sources within a single file.
	 * If not provided, defaults to the primary pipeline in the file.
	 */
	source?: string;
}

/**
 * Complete launch request message for RocketRide debugging sessions.
 * 
 * Combines the standard DAP LaunchRequest structure with RocketRide-specific
 * launch arguments. Used when VS Code initiates a new debug session.
 */
export interface LaunchRequest extends GenericRequest {
	/** 
	 * Command identifier for launch requests.
	 * This distinguishes launch requests from other types of debug adapter requests.
	 */
	command: 'launch';

	/**
	 * The RocketRide-specific arguments for the launch request.
	 * Contains all configuration needed to start a new pipeline debugging session.
	 */
	arguments: LaunchRequestArguments;
}

/**
 * Complete launch response message from the RocketRide debug server.
 * 
 * Returned by the debug server after processing a launch request,
 * containing either success information or error details.
 */
export interface LaunchResponse extends GenericResponse {
	/**
	 * The response body containing RocketRide-specific launch result information.
	 * This body is always present for launch responses, even if some fields are optional.
	 */
	body: {
		/**
		 * The unique task identifier assigned to the launched pipeline.
		 * This token is used for all subsequent communication with the debug server
		 * to identify which pipeline session the messages refer to.
		 * 
		 * May be undefined if the launch failed or if connecting to an existing session
		 * that doesn't provide a new token.
		 */
		token?: string;
	};
}

//=====================================================================================
// ATTACH OPERATIONS
// 
// Attach operations connect to an existing debugging session using a token.
// This allows developers to reconnect to pipelines that are already running
// or to share debugging sessions between multiple clients.
//=====================================================================================

/**
 * Attach request arguments specific to the RocketRide debug adapter.
 *
 * Extends the standard DAP AttachRequestArguments with RocketRide-specific configuration
 * options for attaching to existing pipeline debugging sessions. Used when connecting
 * to pipelines that are already running rather than starting new ones.
 */
export interface AttachRequestArguments extends GenericArguments {
	/**
	 * The token identifying the existing pipeline debugging session to attach to.
	 * This token must correspond to an active debugging session on the target server.
	 * Tokens are typically obtained from previous launch responses or shared between users.
	 */
	token: string;
}

/**
 * Complete attach request message for RocketRide debugging sessions.
 * 
 * Combines the standard DAP AttachRequest structure with RocketRide-specific
 * attach arguments. Used when VS Code connects to an existing debug session
 * rather than starting a new one.
 */
export interface AttachRequest extends GenericRequest {
	/** 
	 * Command identifier for attach requests.
	 * This distinguishes attach requests from other types of debug adapter requests.
	 */
	command: 'attach';

	/**
	 * The RocketRide-specific arguments for the attach request.
	 * Contains all configuration needed to attach to an existing pipeline debugging session.
	 */
	arguments: AttachRequestArguments;
}

/**
 * Complete attach response message from the RocketRide debug server.
 *
 * Returned by the debug server after processing an attach request,
 * containing either success information or error details. For successful
 * attachments, includes the pipeline definition being debugged.
 */
export interface AttachResponse extends GenericResponse {
	/**
	 * The response body containing RocketRide-specific attach result information.
	 * This body is always present for attach responses and contains the pipeline
	 * information for successful attachments.
	 */
	body: {
		/**
		 * The complete pipeline definition object that is currently being debugged.
		 * This allows the client to understand the structure and configuration
		 * of the pipeline it has just attached to, enabling proper debugging
		 * visualization and interaction.
		 */
		pipeline: Record<string, unknown>;
	}
}

//=====================================================================================
// BREAKPOINT OPERATIONS
// 
// Breakpoint operations allow setting, removing, and managing breakpoints in
// pipeline files. RocketRide's breakpoint model supports both component-level
// and connection-level breakpoints with semantic naming.
//=====================================================================================

/**
 * Extended breakpoint definition for pipeline-specific breakpoints.
 * 
 * Adds semantic naming to standard DAP source breakpoints to support
 * RocketRide's pipeline debugging model where breakpoints can be set on
 * specific components or data flow connections within the pipeline.
 */
export interface SetBreakpointsBreakpoint extends DebugProtocol.SourceBreakpoint {
	/**
	 * The line number where the breakpoint is set (1-based indexing).
	 * Inherited from SourceBreakpoint but documented here for clarity.
	 * This corresponds to the line in the pipeline file where the breakpoint is placed.
	 */
	line: number;

	/**
	 * Semantic name for the breakpoint location within the pipeline.
	 * 
	 * This name provides semantic meaning to the breakpoint location beyond just
	 * the line number, allowing the debug server to understand the pipeline context.
	 * 
	 * **Format patterns:**
	 * - Component breakpoints: `"componentId::*::*"`
	 * - Connection breakpoints: `"sourceComponent::lane::targetComponent"`
	 * - Invalid/unresolved locations: `""` (empty string)
	 * 
	 * **Examples:**
	 * - `"fileSource::*::*"` - Break when the fileSource component executes
	 * - `"transformer::output::destination"` - Break on data flowing from transformer's output lane to destination
	 * 
	 * This name is used by the debug server to understand where in the
	 * pipeline execution flow the breakpoint should trigger.
	 */
	name?: string;
}

/**
 * Arguments for setting breakpoints in RocketRide pipeline files.
 * 
 * Extends the standard DAP setBreakpoints arguments with RocketRide-specific
 * breakpoint information and pipeline context. Supports setting breakpoints
 * across multiple related pipelines.
 */
export interface SetBreakpointsArguments extends DebugProtocol.SetBreakpointsArguments {
	/**
	 * Array of breakpoints to set, with RocketRide-specific semantic names.
	 * Each breakpoint includes line number and semantic pipeline location information.
	 * 
	 * If undefined or empty, all existing breakpoints for the specified source will be cleared.
	 * This follows the standard DAP behavior where setBreakpoints replaces all breakpoints
	 * for a given source file.
	 */
	breakpoints?: SetBreakpointsBreakpoint[];

	/**
	 * Array of pipeline names/identifiers that these breakpoints apply to.
	 * 
	 * This allows setting breakpoints across multiple related pipeline files
	 * or specifying which specific pipelines should respect these breakpoints.
	 * Useful in scenarios where:
	 * - A single pipeline file contains multiple pipeline definitions
	 * - Breakpoints should only apply to specific pipeline variants
	 * - Cross-pipeline debugging scenarios with shared components
	 * 
	 * If undefined or empty, breakpoints apply to all pipelines in the source file.
	 */
	pipelines?: string[];
}

/**
 * Complete setBreakpoints request for RocketRide pipeline debugging.
 * 
 * Used when VS Code sends breakpoint configuration to the debug adapter,
 * typically when users add, remove, or modify breakpoints in pipeline files
 * through the VS Code editor interface.
 */
export interface SetBreakpointsRequest extends GenericRequest {
	/** 
	 * Command identifier for setBreakpoints requests.
	 * This distinguishes breakpoint requests from other types of debug adapter requests.
	 */
	command: 'setBreakpoints';

	/**
	 * The RocketRide-specific arguments for setting breakpoints.
	 * Contains breakpoint definitions with semantic pipeline location information
	 * and optional pipeline filtering.
	 */
	arguments: SetBreakpointsArguments;
}

//=====================================================================================
// UNION TYPES FOR PROTOCOL MESSAGE DISCRIMINATION
// 
// These union types provide type-safe discrimination for handling different
// message types in the debug adapter protocol implementation.
//=====================================================================================

/**
 * Union type of all supported request message types.
 * Used for type-safe handling of incoming requests in the debug adapter.
 * 
 * This discriminated union allows TypeScript to provide proper type checking
 * and autocompletion when processing different types of requests.
 */
export type Request =
	| GenericArguments
	| LaunchRequest
	| AttachRequest
	| SetBreakpointsRequest;

/**
 * Union type of all supported response message types.
 * Used for type-safe handling of outgoing responses from the debug adapter.
 * 
 * This discriminated union allows TypeScript to provide proper type checking
 * when sending responses back to VS Code. Note that some responses use
 * the standard DAP types directly when no RocketRide-specific extensions are needed.
 */
export type Response =
	| GenericResponse
	| LaunchResponse
	| AttachResponse
	| DebugProtocol.SetBreakpointsResponse;
