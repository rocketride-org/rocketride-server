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
 * icons.ts - Icon Constants for RocketRide VS Code Extension
 * 
 * This module provides a centralized collection of emoji-based icons used throughout
 * the VS Code extension for consistent visual feedback in logs, messages, and UI elements.
 * 
 * Using emojis as icons provides several benefits:
 * - Universal visual recognition across different VS Code themes
 * - No need for external icon files or SVG assets
 * - Consistent appearance across different operating systems
 * - Easy to identify different types of messages in logs and output channels
 * 
 * All icons are exported as a single object to enable easy importing and
 * prevent typos when referencing icon names throughout the codebase.
 */

/**
 * Centralized icon definitions using emoji characters
 * 
 * Each icon represents a specific state, action, or message type used throughout
 * the extension. The naming convention follows a descriptive approach where
 * the property name clearly indicates the intended use case.
 *
 * Icon Categories:
 * - Status indicators: begin, success, error, warning, info
 * - Process states: launch, stop
 * - Communication: send, receive
 */
export const icons = {
	/** 🟢 Indicates the start of a process or operation */
	begin: '🟢',

	/** ❌ Shows general errors or failed operations */
	error: '❌',

	/** ℹ️ Displays informational messages or status updates */
	info: 'ℹ️',

	/** 🚀 Indicates launching or starting of applications/processes */
	launch: '🚀',

	/** ⬅️ Shows incoming data, messages, or responses from external sources */
	receive: '⬅️',

	/** ➡️ Shows outgoing data, messages, or requests to external sources */
	send: '➡️',

	/** 🛑 Indicates stopping, termination, or halting of operations */
	stop: '🛑',

	/** ✅ Shows successful completion of operations */
	success: '✅',

	/** ⚠️ Indicates warnings or potential issues that don't prevent operation */
	warning: '⚠️'
};
