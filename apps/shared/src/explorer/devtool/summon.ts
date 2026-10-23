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
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER DEV TOOL — SUMMON (a frame asks its host to mount the controller)
// =============================================================================
//
// Since #2625 9bd5d931f a host builds a tool's sidebar (its controller) only
// when the tool's tab is selected, or when busPeer summons it: while no
// controller is subscribed, the sidebar peer holds every frame message and
// emits `host.mountToolSidebar` once per hold period (busPeer.ts
// deliverToSidebar). A frame whose controller is not ready (no nonce on
// `devtool:controller`) uses that on purpose, with ONE event:
//
//   - An EVENT, never a call. On the summon-driven mount, a call the peer held
//     is delivered into the host channel's subscription (both hosts build it
//     before the controller's effect) and dropped; the frame's callers wait
//     for readiness instead (frame.ts).
//   - SUMMON_EVENT sits under the library's reserved `devtool:` prefix, so it
//     is never an op name (quirk 7: the op server would execute it). No
//     controller listens for it, so the copies a mounting controller receives
//     (the held burst and the retained last frame payload, quirks 2 and 3) do
//     nothing.
//   - Sent only after SUMMON_SETTLE_MS without a nonce, so a frame whose
//     controller is already up (its retained readiness replays on subscribe)
//     sends nothing. Re-sent at SUMMON_RETRY_MS while no nonce arrives. That
//     helps one case only: rocket-ui arms a tool's sidebar peer once its
//     pinned-tool list is known, and a live signal sent before that is lost.
//     It does not help a peer that is armed but whose host has no handler for
//     `host.mountToolSidebar` (rocket-ui's collapsed sidebar unmounts the
//     chrome that handles it): busPeer then latches its once-per-hold summon
//     until a controller subscribes, and the re-sends are only held.
//   - Not sent while the host says it is disconnected: no controller can mount
//     then (the hosts render a "Connect …" status in its place).
//   - A GRACE: `state()` is 'summoning' until SUMMON_GRACE_MS have passed in
//     an episode without a nonce, then 'unanswered'. Frames say "open the
//     sidebar" only once it is unanswered, so the text does not flash while
//     the host mounts the controller. The grace starts again whenever the
//     host connection comes back.
//   - A nonce that goes away (the controller unmounted) starts a new episode.
//
// The copy a frame puts in the peer's single retained slot replaces the last
// event it sent there, so a controller that remounts later hears this event
// instead of, say, the frame's last `active`. Lanes re-announce what matters
// once a controller is ready.
// =============================================================================

import type { ToolChannel } from 'shell';
import { HOST_CONNECTION_TOPIC } from './frame';
import { CONTROLLER_STATE_TOPIC, RESERVED_STATE_PREFIX } from './realm';

/** The event a frame sends to have its controller mounted (never an op name). */
export const SUMMON_EVENT = `${RESERVED_STATE_PREFIX}summon`;

/** How long a frame listens for a retained readiness nonce before it summons. */
export const SUMMON_SETTLE_MS = 250;

/** The delays between re-sends while no controller answers (then it stops). */
export const SUMMON_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** How long an episode waits for a controller before the frame says to open the sidebar. */
export const SUMMON_GRACE_MS = 5_000;

/**
 * Where the summon stands:
 *
 *   ready        a readiness nonce is held (it can outlive a host disconnect;
 *                callers check the host connection first);
 *   summoning    no nonce, still inside the grace, or no nonce while the host
 *                is disconnected (the grace waits for the host);
 *   unanswered   the grace passed without a nonce: say to open the sidebar.
 */
export type SummonState = 'ready' | 'summoning' | 'unanswered';

/** What {@link createControllerSummon} needs. */
export interface IControllerSummonOptions {
	/** The frame's channel (DevToolProps.channel, or the one built over its peer). */
	channel: ToolChannel;
	/** Runs `fn` after `ms`; returns a cancel (default setTimeout; tests inject their own). */
	schedule?: (fn: () => void, ms: number) => () => void;
}

/** A frame's summon. */
export interface IControllerSummon {
	/** Where the summon stands. */
	state(): SummonState;
	/** Be told of every change of state; returns unsubscribe. */
	subscribe(cb: (state: SummonState) => void): () => void;
	/** How many summon events this frame sent. */
	sent(): number;
	/** Stop (the frame's effect cleanup; idempotent). */
	dispose(): void;
}

/**
 * Default scheduler.
 *
 * @param fn - What to run.
 * @param ms - After how long.
 * @returns Cancel.
 */
function defaultSchedule(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
}

/**
 * Start summoning the frame's controller whenever it is not ready.
 *
 * @param opts - See {@link IControllerSummonOptions}.
 * @returns The summon; dispose it in the frame's cleanup.
 */
export function createControllerSummon(opts: IControllerSummonOptions): IControllerSummon {
	const { channel } = opts;
	const schedule = opts.schedule ?? defaultSchedule;
	const listeners = new Set<(state: SummonState) => void>();
	let ready = false;
	let hostDown = false;
	let graceOver = false;
	let count = 0;
	let disposed = false;
	const cancels: Array<() => void> = [];
	let last: SummonState = 'summoning';

	const current = (): SummonState => (ready ? 'ready' : graceOver ? 'unanswered' : 'summoning');

	const notify = (): void => {
		const next = current();
		if (next === last) return;
		last = next;
		for (const listener of [...listeners]) listener(next);
	};

	const stopEpisode = (): void => {
		for (const cancel of cancels.splice(0)) cancel();
	};

	const send = (): void => {
		if (disposed || ready || hostDown) return;
		count += 1;
		channel.sendEvent(SUMMON_EVENT, null);
	};

	const startEpisode = (): void => {
		stopEpisode();
		graceOver = false;
		if (disposed || ready || hostDown) return;
		let at = SUMMON_SETTLE_MS;
		cancels.push(schedule(send, at));
		for (const delay of SUMMON_RETRY_MS) {
			at += delay;
			cancels.push(schedule(send, at));
		}
		cancels.push(schedule(() => {
			graceOver = true;
			notify();
		}, SUMMON_GRACE_MS));
	};

	const offReady = channel.onState(CONTROLLER_STATE_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { ready?: unknown }).ready : undefined;
		const next = typeof value === 'string' && value !== '';
		if (next === ready) return;
		ready = next;
		if (ready) stopEpisode();
		else startEpisode();
		notify();
	});

	const offConnection = channel.onState(HOST_CONNECTION_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { connected?: unknown }).connected : undefined;
		if (typeof value !== 'boolean') return;
		const down = !value;
		if (down === hostDown) return;
		hostDown = down;
		if (hostDown) {
			stopEpisode();
			graceOver = false;
		} else if (!ready) {
			startEpisode();
		}
		notify();
	});

	startEpisode();

	return {
		state: () => current(),
		subscribe(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		sent: () => count,
		dispose() {
			if (disposed) return;
			disposed = true;
			stopEpisode();
			offReady();
			offConnection();
			listeners.clear();
		},
	};
}
