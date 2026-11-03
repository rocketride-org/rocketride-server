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
// WIRE PROTOCOL — the engine's generic event envelope
// =============================================================================
//
// The one wire shape the extension still consumes directly: task/flow events
// forwarded off the engine connection (ProjectProvider). The DAP
// request/response types that used to live here left with src/debugger/.

/**
 * Generic body interface for protocol message responses and events.
 * Provides a flexible base for all response/event body types, allowing any string-keyed properties.
 * This serves as the foundation for more specific body interfaces.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DAP protocol bodies are inherently open-ended
export interface GenericBody extends Record<string, any> { }

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

	/** 
	 * Sequence number for this event message.
	 * This is managed automatically by the Debug Adapter Protocol implementation.
	 */
	seq?: number;
}
