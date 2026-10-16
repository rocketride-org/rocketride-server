// MIT License
//
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
// useConversationCapture — the live nudge, and nothing else
// =============================================================================
//
// THIS HOOK NO LONGER CAPTURES ANYTHING. Capture is the discord node's job:
// `resolvePipeline` gives the bot's own pipeline a `capture_db` component and
// turns `captureEvents` on, so every question, reply and reaction is written
// into the dashboard database
// server-side, whether or not anybody has the app open. That was the whole
// point of the move — the browser used to be the only writer, and a question
// asked while every tab was closed was a question nothing recorded.
//
// What is left is the part that made the screen feel alive: the shell
// forwards the node's `apaevt_sse` broadcasts, and one arriving means a row
// has just been written. So the hook subscribes the running tasks' monitors
// and, on anything that looks like one of ours, asks `useDashboardData` to
// poll NOW instead of waiting out the five-second tick.
//
// THE EVENT IS A TRIGGER, NOT DATA. Nothing is decoded for its content and
// nothing is folded here: the row is already on its way into the database
// from the node, and reading it back is what makes two open tabs agree. A
// push that is lost costs at most one poll interval.
//
// The folding rules the browser used to run live in `src/db/fold.ts`,
// unchanged.
//
// SDK calls used, from packages/client-typescript/src/client/client.ts:
//   addMonitor     (2078) — subscribe the task's event categories
//   removeMonitor  (2117) — release the subscription on unmount
// =============================================================================

import { useEffect, useRef } from 'react';
import { useShellEvent, useShellConnection } from 'shell';
import { parseDiscordEvent, SSE_EVENT_NAME } from './parseEvent';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Event categories to subscribe. SSE carries the node's own broadcasts — the
 * only channel that exposes its metadata contract (see `parseEvent.ts`); TASK
 * carries the lifecycle so the header notices a task that died between status
 * polls.
 *
 * Names are matched case-insensitively against the engine's EVENT_TYPE enum
 * (`packages/ai/src/ai/modules/task/commands/cmd_monitor.py`).
 */
const MONITOR_TYPES = ['SSE', 'TASK'];

/**
 * Shortest gap between two pushed polls (ms).
 *
 * One Discord message fans out into several objects, so a burst would
 * otherwise ask the database five times for the same five rows. The trailing
 * timer collapses a burst into one read — the same reasoning the old flush
 * timer had, applied to a read rather than to a write.
 */
const NUDGE_MS = 400;

// =============================================================================
// HOOK
// =============================================================================

/**
 * Subscribe the running tasks' events and nudge the data layer when one lands.
 *
 * @param tokens - The task tokens to subscribe: the bot's and, when it is
 *        running, the eval-capture branch's. Nulls are ignored.
 * @param onEvent - Called when a node event arrives, coalesced. The data
 *        layer's `poll`.
 * @param enabled - False in sample-data mode: nothing is subscribed.
 */
export function useConversationCapture(tokens: (string | null)[], onEvent: () => void, enabled: boolean): void {
	const { client, isConnected } = useShellConnection();
	// A stable key for the effect below: the token list, order-independent, so a
	// re-render with the same tasks never re-subscribes.
	const live = tokens.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
	const liveKey = live.slice().sort().join('|');

	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Read inside the timer callback, so a new callback needs no re-arm.
	const onEventRef = useRef(onEvent);
	onEventRef.current = onEvent;

	// --- Subscription ---------------------------------------------------------

	useEffect(() => {
		if (!enabled || !isConnected || !client) return;
		const keys = liveKey.length > 0 ? liveKey.split('|').map((token) => ({ token })) : [];
		if (keys.length === 0) return;
		for (const key of keys) {
			client.addMonitor(key, MONITOR_TYPES).catch((err: unknown) => {
				console.error('[discord-dashboard] addMonitor failed', err);
			});
		}
		return () => {
			for (const key of keys) {
				client.removeMonitor(key, MONITOR_TYPES).catch(() => undefined);
			}
		};
		// `liveKey` IS the token list — deriving the keys from it inside the
		// effect is what keeps the subscription from churning on every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, isConnected, client, liveKey]);

	// --- Arrival --------------------------------------------------------------

	// useShellEvent keeps the handler in a ref and calls the latest version per
	// event, so this closure always reads the current `enabled` / token list.
	useShellEvent('shell:event', ({ event }) => {
		if (!enabled || liveKey.length === 0) return;
		const message = event as { type?: string; event?: string; body?: unknown };
		if (message.type !== 'event' || message.event !== SSE_EVENT_NAME) return;
		// Only the broadcast that means a row was written: the node's own event.
		// Everything else on this channel ("thinking", a model's tokens, a tool
		// call) changes nothing in the database and must not cost a read.
		if (parseDiscordEvent(message.body) === null) return;
		if (timer.current !== null) return;
		timer.current = setTimeout(() => {
			timer.current = null;
			onEventRef.current();
		}, NUDGE_MS);
	});

	// No timer outlives the component.
	useEffect(
		() => () => {
			if (timer.current !== null) {
				clearTimeout(timer.current);
				timer.current = null;
			}
		},
		[]
	);
}
