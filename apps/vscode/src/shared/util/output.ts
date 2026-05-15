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
 * output.ts - Centralized Logging System for RocketRide VS Code Extension
 * 
 * This module implements a singleton-based logging system that provides consistent
 * output handling throughout the VS Code extension. The logger writes to a named
 * OutputChannel in VS Code, allowing users to view extension logs in the Output panel.
 * 
 * Key Features:
 * - Singleton pattern ensures consistent logging across the extension
 * - Named output channel ("RocketRide") for easy identification
 * - Integration with the icons system for visual message categorization
 * - Error throwing capability with automatic logging
 * - Channel visibility management for user interaction
 * 
 * Usage Pattern:
 * 1. Import getLogger() function in any module
 * 2. Call getLogger() to get the shared logger instance
 * 3. Use output() for general logging or throwError() for fatal errors
 */

import * as vscode from 'vscode';
import { icons } from './icons';

/**
 * Case-insensitive regex matching sensitive key names.
 */
const SENSITIVE_KEY_PATTERN = new RegExp(
	[
		'auth[-_]?key',
		'auth[-_]?token',
		'authorization',
		'api[-_]?key',
		'access[-_]?token',
		'refresh[-_]?token',
		'private[-_]?key',
		'token',
		'bearer',
		'password',
		'secret',
		'credential',
	].join('|'),
	'i'
);

/**
 * Recursively redacts sensitive fields in an object.
 * Modifies the object in place, replacing values of sensitive keys with "*****".
 *
 * @param obj The object to redact (will be modified in place)
 */
function redactSensitiveFields(obj: unknown): void {
	if (obj === null || obj === undefined) {
		return;
	}

	// Handle arrays
	if (Array.isArray(obj)) {
		for (const item of obj) {
			redactSensitiveFields(item);
		}
		return;
	}

	// Handle objects
	if (typeof obj === 'object') {
		const record = obj as Record<string, unknown>;
		for (const key in record) {
			if (Object.prototype.hasOwnProperty.call(record, key)) {
				// Check if key contains any sensitive pattern (case-insensitive)
				if (SENSITIVE_KEY_PATTERN.test(key)) {
					record[key] = '*****';
				} else {
					// Recursively process nested objects/arrays
					redactSensitiveFields(record[key]);
				}
			}
		}
	}
}

/**
 * Safely converts an object to JSON string with sensitive fields redacted.
 * 
 * This function uses a lazy redaction strategy for optimal performance:
 * 1. Stringify the object first (required anyway for output)
 * 2. Quick regex search for sensitive field patterns
 * 3. Only if found, parse, redact, and re-stringify
 * 
 * This ensures minimal overhead for the common case where no sensitive
 * data is present, while still protecting keys when they do appear.
 * 
 * @param obj The object to stringify
 * @returns JSON string with sensitive values redacted
 */
export function safeJSONStringify(obj: unknown): string {
	// Stringify first - we need to do this anyway
	const jsonString = JSON.stringify(obj);

	// Quick check: does the serialized string contain any sensitive field names?
	if (SENSITIVE_KEY_PATTERN.test(jsonString)) {
		// Yes - parse (creating a deep clone), redact, and re-stringify
		const parsed = JSON.parse(jsonString);
		redactSensitiveFields(parsed);
		return JSON.stringify(parsed);
	}

	// No sensitive data - return original string (fast path)
	return jsonString;
}

/**
 * Singleton logger class that manages all extension output to VS Code's Output panel.
 * 
 * This class follows the singleton pattern to ensure that all logging throughout
 * the extension uses the same OutputChannel instance, providing consistency and
 * preventing resource conflicts.
 * 
 * The logger is designed to be thread-safe and can be safely called from any
 * part of the extension without concerns about multiple instances or conflicting
 * output streams.
 */
class OutputLogger {
	/** Static instance holder for singleton pattern implementation */
	private static instance: OutputLogger;

	/** Extension channel: DAP traffic, connection lifecycle, diagnostics */
	private readonly outputChannel: vscode.OutputChannel;

	/** Console channel: plain server output (stdout/stderr from pipelines) */
	private readonly consoleChannel: vscode.OutputChannel;

	private constructor() {
		this.outputChannel = vscode.window.createOutputChannel('Rocket Ride: Extension');
		this.consoleChannel = vscode.window.createOutputChannel('Rocket Ride: Console');
	}

	/**
	 * Gets the singleton instance of the logger.
	 * 
	 * This method implements lazy initialization - the logger instance is only
	 * created when first requested. Subsequent calls return the same instance,
	 * ensuring consistent logging behavior across the entire extension.
	 * 
	 * Thread Safety: This implementation is safe for single-threaded JavaScript
	 * execution but would require additional synchronization in multi-threaded
	 * environments.
	 * 
	 * @returns The shared OutputLogger instance
	 */
	public static getInstance(): OutputLogger {
		// Check if instance already exists
		if (!OutputLogger.instance) {
			// Create new instance if this is the first call
			OutputLogger.instance = new OutputLogger();
		}

		// Return the singleton instance
		return OutputLogger.instance;
	}

	/**
	 * Logs a message to the output channel.
	 * 
	 * Messages are appended as new lines to the output channel, making them
	 * visible in VS Code's Output panel when the "RocketRide" channel is selected.
	 * 
	 * The method supports any string content, including formatted messages with
	 * icons, timestamps, or structured data. No automatic formatting is applied,
	 * giving callers full control over message presentation.
	 * 
	 * @param message The message to log - can include emojis, formatting, or plain text
	 */
	public output(message: string): void {
		this.outputChannel.appendLine(message);
	}

	/**
	 * Logs plain text to the "Rocket Ride: Console" output channel.
	 */
	public console(message: string): void {
		this.consoleChannel.appendLine(message);
	}

	public error(message: string): void {
		this.output(`${icons.error} ${message}`);
	}

	public info(message: string): void {
		this.output(`${icons.info} ${message}`);
	}

	/**
	 * Output an exception message and throw an error.
	 * 
	 * This method combines logging and error throwing to provide consistent
	 * error handling throughout the extension. It ensures that all fatal errors
	 * are logged before being thrown, preventing loss of diagnostic information
	 * if the error isn't caught upstream.
	 * 
	 * The stop icon is automatically prepended to error messages to provide
	 * visual distinction in the logs and indicate the severity of the issue.
	 * 
	 * TypeScript Return Type: The `never` return type indicates this method
	 * never returns normally (always throws), helping with static analysis
	 * and dead code detection.
	 * 
	 * @param message Message to log and include in the thrown error
	 * @throws Always throws an Error with the provided message
	 * @returns Never returns (always throws) - indicated by `never` return type
	 */
	public throwError(message: string): never {
		// Log the error message with a stop icon for visual identification
		// This ensures the error is captured in logs even if not caught elsewhere
		this.output(`${icons.stop} ${message}`);

		// Throw a new Error instance with the same message
		// This allows callers to catch and handle the error if needed
		throw new Error(message);
	}

	/**
	 * Makes the output channel visible to the user.
	 * 
	 * This method programmatically opens the Output panel and switches to the
	 * "RocketRide" channel, bringing it into focus for the user. This is useful
	 * for drawing attention to important log messages or errors.
	 * 
	 * The `preserveFocus` parameter (true) ensures that keyboard focus remains
	 * on the current editor or panel, preventing disruption to the user's
	 * workflow while still making the logs visible.
	 * 
	 * Use Cases:
	 * - After critical errors to show diagnostic information
	 * - When starting debug sessions to provide real-time feedback
	 * - During long operations to show progress updates
	 */
	public show(): void {
		// Show the output channel with preserve focus enabled
		// preserveFocus: true means the current editor/panel keeps keyboard focus
		// while the Output panel becomes visible in the background
		this.outputChannel.show(true);
	}
}

/**
 * Factory function that returns the shared logger instance.
 * 
 * This function provides a clean, simple API for accessing the singleton logger
 * without exposing the OutputLogger class directly. It encapsulates the singleton
 * pattern implementation and provides a consistent interface for all extension modules.
 * 
 * Design Benefits:
 * - Hides the complexity of the singleton pattern from consumers
 * - Provides a functional interface that's easy to import and use
 * - Enables future refactoring of the logger implementation without changing the API
 * - Follows the principle of least privilege by not exposing unnecessary class methods
 * 
 * @returns The shared OutputLogger instance for consistent logging across the extension
 */
export function getLogger(): OutputLogger {
	// Delegate to the singleton getInstance method
	// This abstraction allows for future changes to the logger implementation
	// without requiring updates to all consuming modules
	return OutputLogger.getInstance();
}
