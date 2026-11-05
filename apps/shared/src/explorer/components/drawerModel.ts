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
// EXPLORER — ENDPOINT DRAWER MODEL (what the drawer inspects, what its probe said)
// =============================================================================
//
// The record drawer's selection and probe lifecycle, kept outside React so the
// rules can be tested without a DOM (the repository has no component harness).
// EndpointDrawer creates one per mounted drawer and renders its view.
//
// A PROBE RESULT BELONGS TO ONE SELECTION
//   Every probe takes a generation ticket. Re-seeding the drawer (it opened,
//   or the caller's preselection changed), picking another endpoint and the
//   selection leaving the list move the generation on, so a probe that
//   answers afterwards is dropped instead of describing a different node.
//
// THE SELECTION LEAVES WITH ITS ENDPOINT
//   The endpoint store keeps an endpoint that vanished from discovery listed
//   (as `stopped`), so a key leaves the list only when the store resets: on
//   sign-out and on a change of user, organization or team. The drawer then
//   forgets the selection and the probe result with it (the database name and
//   table count it showed belonged to the previous account), and a probe
//   still in flight is dropped when it answers. A reset publishes the empty
//   list, and the next account's list needs a round trip to the server, so
//   the drawer sees the empty list even when that account lists the same key.
//   An open drawer then takes the first endpoint of the fresh list, as it
//   does in pick mode.
// =============================================================================

import { createGeneration } from '../generation';
import type { IGenerationTicket } from '../generation';

// =============================================================================
// TYPES
// =============================================================================

/** Probe lifecycle of the drawer. */
export type DrawerProbeStatus = 'idle' | 'probing' | 'done';

/** What the drawer shows. Replaced (never mutated) on every change. */
export interface IDrawerView<P> {
	/** Key of the endpoint being inspected (null: nothing picked). */
	readonly selectedKey: string | null;
	/** Where the probe of that endpoint stands. */
	readonly status: DrawerProbeStatus;
	/** The finished probe's result (null unless `status` is `done`). */
	readonly probe: P | null;
}

/** The drawer's model (one per mounted drawer). */
export interface IDrawerModel<P> {
	/** The current view (stable until the next change; useSyncExternalStore-compatible). */
	get(): IDrawerView<P>;
	/** Subscribe to changes; returns the unsubscribe function. */
	subscribe(listener: () => void): () => void;
	/**
	 * The drawer opened, or the caller's preselection changed: inspect `key`
	 * and drop any probe result, finished or in flight.
	 *
	 * @param key - The endpoint to inspect, or null when there is none.
	 */
	seed(key: string | null): void;
	/**
	 * The person picked another endpoint: inspect it and drop any probe result.
	 *
	 * @param key - The endpoint picked.
	 */
	select(key: string): void;
	/**
	 * The endpoint list changed. A selection that is no longer listed (the
	 * store reset) is forgotten with its probe result, and a probe in flight is
	 * dropped. An open drawer with nothing picked takes the first endpoint; a
	 * live selection is never replaced by a background refresh.
	 *
	 * @param endpoints - The endpoints listed now.
	 * @param open - Whether the drawer is open.
	 */
	sync(endpoints: ReadonlyArray<{ readonly key: string }>, open: boolean): void;
	/**
	 * A probe of the selection starts.
	 *
	 * @returns The ticket its result must carry.
	 */
	startProbe(): IGenerationTicket;
	/**
	 * A probe answered.
	 *
	 * @param ticket - The ticket {@link startProbe} issued.
	 * @param result - What the probe returned.
	 * @returns True when it was shown; false when the selection changed meanwhile and it was dropped.
	 */
	finishProbe(ticket: IGenerationTicket, result: P): boolean;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a drawer model with nothing picked.
 *
 * @returns The model.
 */
export function createDrawerModel<P>(): IDrawerModel<P> {
	let view: IDrawerView<P> = { selectedKey: null, status: 'idle', probe: null };
	const listeners = new Set<() => void>();
	const generation = createGeneration();

	/**
	 * Replace the view and notify.
	 *
	 * @param next - The new view.
	 */
	function publish(next: IDrawerView<P>): void {
		view = next;
		listeners.forEach((listener) => listener());
	}

	/**
	 * Inspect `key` with no probe result, expiring every earlier ticket.
	 *
	 * @param key - The endpoint to inspect, or null.
	 */
	function inspect(key: string | null): void {
		generation.invalidate();
		publish({ selectedKey: key, status: 'idle', probe: null });
	}

	return {
		get: () => view,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		seed: inspect,
		select: inspect,
		sync(endpoints, open): void {
			let next = view;
			const selected = next.selectedKey;
			if (selected !== null && !endpoints.some((endpoint) => endpoint.key === selected)) {
				// The store reset: the selection and its result belonged to the
				// previous account, and so does any answer still on its way.
				generation.invalidate();
				next = { selectedKey: null, status: 'idle', probe: null };
			}
			const first = endpoints[0];
			if (open && next.selectedKey === null && first !== undefined) next = { ...next, selectedKey: first.key };
			if (next !== view) publish(next);
		},
		startProbe(): IGenerationTicket {
			const ticket = generation.next();
			publish({ ...view, status: 'probing', probe: null });
			return ticket;
		},
		finishProbe(ticket, result): boolean {
			if (!generation.isCurrent(ticket)) return false;
			publish({ ...view, status: 'done', probe: result });
			return true;
		},
	};
}
