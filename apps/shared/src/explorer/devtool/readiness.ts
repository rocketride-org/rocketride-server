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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,

// =============================================================================
// EXPLORER DEV TOOL — READINESS (tri-state; absence is never "disconnected")
// =============================================================================
//
// Two questions, answered by two different parties, each with a "do not know
// yet" answer that must not be rendered as a negative:
//
//   CONTROLLER mount (owns the realm's client): may it talk to the engine?
//     The realm's client is null until the realm can answer truthfully (the
//     root before `init()`; a mirrored realm until the first identity
//     mirror), and `isConnected` says whether the socket is up.
//       client null                 -> 'waiting'
//       client present, not up      -> 'disconnected'
//       client present and up       -> 'ready'
//     Engine requests are gated on 'ready' (and a request made before it
//     rejects as `unavailable` without being sent: engineClient.ts).
//
//   FRAME mount (holds no client, R1): what may it show?
//     `host:connection` is published by the HOST; until its first snapshot a
//     frame knows nothing. The controller's readiness nonce (controller.ts) and
//     the summon's state (summon.ts) say whether coordination can happen.
//       no host snapshot yet        -> 'waiting'
//       host says disconnected      -> 'disconnected'
//       controller ready            -> 'connected'
//       controller unanswered       -> 'controller-unavailable'
//       otherwise                   -> 'waiting'
//
// Nothing here publishes a `host:*` topic: those are the host's.
// =============================================================================

import type { SummonState } from './summon';

/** What a controller knows about its realm's engine connection. */
export type EngineStatus = 'waiting' | 'disconnected' | 'ready';

/** What {@link engineStatus} reads. */
export interface IEngineFacts {
	/** The realm's client (`useShellConnection().client`): null until the realm can answer truthfully. */
	client: unknown;
	/** Whether the realm's socket is up and authenticated (`useShellConnection().isConnected`). */
	isConnected: boolean;
}

/**
 * The controller's engine status.
 *
 * @param facts - The realm's client and connection flag.
 * @returns `waiting` without a client, `disconnected` with one that is not up, `ready` otherwise.
 */
export function engineStatus(facts: IEngineFacts): EngineStatus {
	if (facts.client === null || facts.client === undefined) return 'waiting';
	return facts.isConnected === true ? 'ready' : 'disconnected';
}

/** What a frame can show. */
export type FrameStatus = 'waiting' | 'disconnected' | 'connected' | 'controller-unavailable';

/**
 * The frame's status.
 *
 * @param hostConnected - The last `host:connection` snapshot: true / false, or null / undefined before the host published one.
 * @param controller - Where the controller summon stands (summon.ts `state()`).
 * @returns The status (see the header).
 */
export function frameStatus(hostConnected: boolean | null | undefined, controller: SummonState): FrameStatus {
	if (hostConnected === null || hostConnected === undefined) return 'waiting';
	if (!hostConnected) return 'disconnected';
	if (controller === 'ready') return 'connected';
	return controller === 'unanswered' ? 'controller-unavailable' : 'waiting';
}

/** A controller's engine readiness, as a store the discovery gate and React follow. */
export interface IEngineReadiness {
	/** The current status. */
	status(): EngineStatus;
	/** Whether engine requests may be sent now. */
	isReady(): boolean;
	/** Feed the realm's latest client and connection flag (React: an effect over `useShellConnection()`). */
	set(facts: IEngineFacts): void;
	/** Be told of every change of status; returns unsubscribe. */
	subscribe(cb: (status: EngineStatus) => void): () => void;
}

/**
 * Build a controller's readiness store (starts 'waiting').
 *
 * @param initial - The facts known at mount, when any.
 * @returns The store.
 */
export function createEngineReadiness(initial?: IEngineFacts): IEngineReadiness {
	let current: EngineStatus = initial ? engineStatus(initial) : 'waiting';
	const listeners = new Set<(status: EngineStatus) => void>();
	return {
		status: () => current,
		isReady: () => current === 'ready',
		set(facts) {
			const next = engineStatus(facts);
			if (next === current) return;
			current = next;
			for (const listener of [...listeners]) listener(next);
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
	};
}
