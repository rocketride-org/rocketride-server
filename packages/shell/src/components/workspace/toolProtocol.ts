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
// TOOL PROTOCOL — typed protocol maps over the tool channel
// =============================================================================
//
// The shell event bus pattern (ShellEventMap), applied to the tool channel:
// the HOST declares a base set of system topics every channel is born with,
// and each tool privately extends the base with its own — strict-typed end
// to end, no central registry, no cross-tool collisions:
//
//   // The tool's protocol module — private to the tool:
//   interface SqlStateMap extends ToolStateMap {
//       connections: SavedSqlConnection[];
//   }
//   interface SqlEventMap extends ToolEventMap {
//       saveConnection: SavedSqlConnection;
//   }
//
//   // Either mount:
//   const sql = typedToolChannel<SqlStateMap, SqlEventMap>(channel);
//   sql.publishState('connections', list);          // key + payload checked
//   const ready = useConnectionReady(sql);          // system topic, for free
//
// NAMESPACE RULE: keys prefixed `host:` are RESERVED for the base maps.
// The base is contract-frozen and only ever grows; the prefix is what makes
// that growth safe — a future system topic can never land on a key a tool
// chose for itself. Tools must not publish host-prefixed topics; hosts own
// them (rocket-ui's DevToolMount in-shell, the VS Code extension host
// through its DevToolBridge envelope mirror).
//
// Semantics are the channel's, unchanged: state is retained per topic and
// replayed to late subscribers; events are buffered and may summon the
// frame; a state publish never summons anything (toolChannel.ts).
// =============================================================================

import { useEffect, useState } from 'react';
import type { ToolChannel, ToolChannelUnsubscribe } from './toolChannel';

// =============================================================================
// SYSTEM TOPICS — the host-owned base
// =============================================================================

/** The `host:connection` snapshot: the controller realm's connection to the
 *  RocketRide server. Frames hold no connection of their own — a frame's
 *  run/apply enablement derives from this replicated snapshot. */
export interface IHostConnectionState {
	/** Whether the controller realm's server connection is up. */
	connected: boolean;
}

// Wire name of the host connection topic — defined in toolRelay.ts (the
// dependency-light relay module) and re-exported here beside the
// tool-facing surface.
export { HOST_CONNECTION_TOPIC } from './toolRelay';
import { HOST_CONNECTION_TOPIC } from './toolRelay';

/**
 * The base STATE map — system topics every tool channel is born with,
 * published by the HOST (never by a tool). Tools extend this interface
 * with their own topics; `host:`-prefixed keys stay reserved for the base.
 */
export interface ToolStateMap {
	/** The controller realm's server-connection status. HOST-published: the
	 *  host is the one party that always knows it, whether or not the tool's
	 *  controller has ever run (a restored editor panel must read correctly
	 *  before its sidebar mount first boots). */
	'host:connection': IHostConnectionState;
}

/**
 * The base EVENT map. Currently empty — tool-tab activation rides the shell
 * event bus (`shell:toolSidebarActivated`), not the tool channel. Tools
 * extend this interface with their own events; `host:`-prefixed keys stay
 * reserved for the base.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface ToolEventMap {}

// =============================================================================
// TYPED CHANNEL VIEW
// =============================================================================

/**
 * A strict-typed view over a {@link ToolChannel}: every topic and event key
 * comes from the tool's protocol maps, every payload type checks at the
 * call site. Purely a compile-time view — the runtime object IS the
 * underlying channel.
 */
export interface TypedToolChannel<S extends ToolStateMap = ToolStateMap, E extends ToolEventMap = ToolEventMap> {
	/** CONTROLLER ONLY (hosts for `host:*` topics): publish a retained state
	 *  snapshot. Late subscribers receive the latest immediately. */
	publishState<K extends keyof S & string>(topic: K, snapshot: S[K]): void;
	/** Subscribe to a state topic; the retained snapshot (if any) replays
	 *  synchronously before live updates. */
	onState<K extends keyof S & string>(topic: K, cb: (snapshot: S[K]) => void): ToolChannelUnsubscribe;
	/** Send an event to the other side. Buffered while the other side opens;
	 *  an event MAY summon a closed window — send only for user actions and
	 *  directed commands. */
	sendEvent<K extends keyof E & string>(name: K, payload: E[K]): void;
	/** Subscribe to an event by name. Events are not retained. */
	onEvent<K extends keyof E & string>(name: K, cb: (payload: E[K]) => void): ToolChannelUnsubscribe;
}

/**
 * Narrows a raw channel to the tool's typed protocol view. A cast, not a
 * wrapper: the returned object is the same channel instance.
 *
 * @param channel - The mount's channel (DevToolProps.channel, or one built
 *                  with createToolChannel).
 * @returns The same channel, typed by the tool's protocol maps.
 */
export function typedToolChannel<S extends ToolStateMap = ToolStateMap, E extends ToolEventMap = ToolEventMap>(channel: ToolChannel): TypedToolChannel<S, E> {
	return channel as unknown as TypedToolChannel<S, E>;
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * The live snapshot of one state topic, or undefined until the first
 * (possibly retained) snapshot arrives.
 *
 * @param channel - The mount's typed channel.
 * @param topic - The topic to follow.
 * @returns The latest snapshot, or undefined.
 */
export function useToolState<S extends ToolStateMap, E extends ToolEventMap, K extends keyof S & string>(channel: TypedToolChannel<S, E>, topic: K): S[K] | undefined {
	const [snapshot, setSnapshot] = useState<S[K] | undefined>(undefined);
	useEffect(() => channel.onState(topic, setSnapshot), [channel, topic]);
	return snapshot;
}

/**
 * Whether the controller realm's server connection is up, from the retained
 * `host:connection` system topic — TRI-STATE:
 *
 *   true       the host said connected
 *   false      the host said disconnected
 *   undefined  no snapshot has arrived — NO IDEA YET
 *
 * Absence of a snapshot is never evidence of a negative: render a waiting
 * state on undefined, never a "disconnected" claim (that lie cost a day).
 * Boolean gates (`if (!ready)`) keep working — undefined gates like false.
 *
 * @param channel - The mount's channel (raw or typed).
 * @returns The host's connection level, or undefined before the first snapshot.
 */
export function useConnectionReady(channel: ToolChannel | TypedToolChannel): boolean | undefined {
	const typed = channel as unknown as TypedToolChannel;
	const snapshot = useToolState(typed, HOST_CONNECTION_TOPIC);
	return snapshot === undefined ? undefined : snapshot.connected === true;
}

// =============================================================================
// HOST SIDE
// =============================================================================

/**
 * Publishes the server-connection status into one tool channel's retention.
 * HOST-side: called per tool channel on every connection change (tools
 * never call it). The VS Code extension host mirrors this envelope by hand
 * in its DevToolBridge (it cannot import the browser bundle) — the wire
 * shape here and there must stay identical.
 *
 * @param channel - The tool channel to publish into.
 * @param connected - Whether the server connection is up.
 */
export function publishHostConnectionState(channel: ToolChannel, connected: boolean): void {
	channel.publishState(HOST_CONNECTION_TOPIC, { connected } satisfies IHostConnectionState);
}
