// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

import { DebugProtocol } from '@vscode/debugprotocol';
import { TaskStatus } from './taskStatus';

//=====================================================================================
// Task status update events
//=====================================================================================
/**
 * Status update event message from the debug server.
 * 
 * Sent by the debug server to notify the client of changes in pipeline
 * execution status, component states, or other runtime information.
 * These events are used to update the debugging UI in real-time.
 */
export interface EventStatusUpdate extends DebugProtocol.Event {
	/**
	 * Event type identifier, always 'apaevt_status_update' for these events.
	 * Used by event handlers to distinguish status updates from other event types.
	 */
	event: 'apaevt_status_update';

	/**
	 * The status update payload containing current pipeline state information.
	 * We use onlt the full passive monitoring so it is a TaskStatus structure.
	 */
	body: TaskStatus;
}

//=====================================================================================
// Union type of all RocketRide-specific debug events
//=====================================================================================
export type RocketRideEvent = EventStatusUpdate;
