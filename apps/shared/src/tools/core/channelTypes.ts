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

// =============================================================================
// TOOLS/CORE — typed topic + event definitions over the ToolChannel
// =============================================================================
//
// The raw ToolChannel moves `unknown`; a tool declares its protocol once in
// its `topics.ts` with these definers and gets end-to-end typing at every
// publish/subscribe site:
//
//   // tools/<tool>/topics.ts
//   export const CONNECTIONS = defineStateTopic<SavedSqlConnection[]>('connections');
//   export const SAVE = defineEvent<SavedSqlConnection>('saveConnection');
//
//   // controller
//   publishState(channel, CONNECTIONS, list);
//   onEvent(channel, SAVE, (conn) => upsert(conn));
//
// The definition object is the single place a topic's name and payload type
// meet — a typo'd string or drifted payload shape fails to compile instead
// of silently missing its subscriber.
// =============================================================================

import type { ToolChannel, ToolChannelUnsubscribe } from 'shell';

/** A state topic: name + compile-time payload type. */
export interface ToolStateTopic<T> {
	/** The wire topic name (tool-scoped). */
	readonly topic: string;
	/** Phantom payload carrier — never read at runtime. */
	readonly _type?: T;
}

/** An event: name + compile-time payload type. */
export interface ToolEvent<T> {
	/** The wire event name (tool-scoped). */
	readonly name: string;
	/** Phantom payload carrier — never read at runtime. */
	readonly _type?: T;
}

/**
 * Declares a state topic.
 *
 * @param topic - The wire topic name.
 * @returns The typed topic definition.
 */
export function defineStateTopic<T>(topic: string): ToolStateTopic<T> {
	return { topic };
}

/**
 * Declares an event.
 *
 * @param name - The wire event name.
 * @returns The typed event definition.
 */
export function defineEvent<T>(name: string): ToolEvent<T> {
	return { name };
}

/**
 * Publishes a typed state snapshot (controller side).
 *
 * @param channel - The mount's channel.
 * @param topic - The topic definition.
 * @param snapshot - The snapshot (replaces the retained one).
 */
export function publishState<T>(channel: ToolChannel, topic: ToolStateTopic<T>, snapshot: T): void {
	channel.publishState(topic.topic, snapshot);
}

/**
 * Subscribes to a typed state topic (retained snapshot replays first).
 *
 * @param channel - The mount's channel.
 * @param topic - The topic definition.
 * @param cb - Receives each snapshot.
 * @returns Unsubscribe.
 */
export function onState<T>(channel: ToolChannel, topic: ToolStateTopic<T>, cb: (snapshot: T) => void): ToolChannelUnsubscribe {
	return channel.onState(topic.topic, (snapshot) => cb(snapshot as T));
}

/**
 * Sends a typed event.
 *
 * @param channel - The mount's channel.
 * @param event - The event definition.
 * @param payload - The payload.
 */
export function sendEvent<T>(channel: ToolChannel, event: ToolEvent<T>, payload: T): void {
	channel.sendEvent(event.name, payload);
}

/**
 * Subscribes to a typed event.
 *
 * @param channel - The mount's channel.
 * @param event - The event definition.
 * @param cb - Receives each payload.
 * @returns Unsubscribe.
 */
export function onEvent<T>(channel: ToolChannel, event: ToolEvent<T>, cb: (payload: T) => void): ToolChannelUnsubscribe {
	return channel.onEvent(event.name, (payload) => cb(payload as T));
}
