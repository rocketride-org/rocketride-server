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
// GRAPH - SCHEMA PREVIEW REQUESTS (a sidebar click, taken exactly once)
// =============================================================================
//
// A click on a label or relationship type in the sidebar asks that connection's
// workbench to show and run the 25-row preview. The workbench may not exist yet:
// in VS Code the click summons a COLD webview, which can take seconds to boot,
// and in the full app the tab mounts a render later. So the request is kept
// until a workbench takes it, and taking it is what stops it from running twice:
//
//   - every request carries a NONCE;
//   - `consume(nonce)` clears the pending request when it is still that one, so
//     a workbench that mounts later finds nothing to replay;
//   - a frame realm also remembers the nonces it took (its retained copy of the
//     request can arrive again before the controller's clear does).
//
// There is no freshness window as the de-duplication rule (a 3-second one
// dropped the very click that summoned a cold webview). PREVIEW_MAX_AGE_MS is
// only a backstop: a request nobody took within a minute (its document never
// opened) does not run when that document is opened much later.
// =============================================================================

/** What to preview: the 25-row preview of a node label, or of a relationship type. */
export type PreviewAction = 'label-preview' | 'type-preview';

/** One preview request. Plain data: it crosses the dev-tool channel as retained state. */
export interface IGraphPreview {
	/** Unique per request; a workbench takes a nonce once. */
	nonce: string;
	/** The connection the request is for. */
	endpointKey: string;
	/** Label or relationship type. */
	action: PreviewAction;
	/** The label or relationship type, exactly as the schema holds it. */
	name: string;
	/** When the click happened (epoch ms); see PREVIEW_MAX_AGE_MS. */
	at: number;
}

/** A request older than this is never run (a backstop, not the de-duplication rule). */
export const PREVIEW_MAX_AGE_MS = 60_000;

/** The pending request, and how to take it. */
export interface IPreviewStore {
	/** The pending request, or null (stable until it changes). */
	get(): IGraphPreview | null;
	/** Be told about every change; returns unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Leave a request, replacing one that was not taken. */
	request(input: { endpointKey: string; action: PreviewAction; name: string }): IGraphPreview;
	/** Take the pending request when it is `nonce`; true when it was. */
	consume(nonce: string): boolean;
	/** Drop the pending request (identity change). */
	clear(): void;
}

let counter = 0;

/**
 * A request nonce: unique within a realm, and across realms in practice (time, counter and randomness).
 *
 * @param now - The clock.
 * @returns The nonce.
 */
export function newNonce(now: () => number = Date.now): string {
	counter += 1;
	return `${now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a preview store.
 *
 * @param opts - Clock and nonce source (tests).
 * @returns The store.
 */
export function createPreviewStore(opts: { now?: () => number; nonce?: () => string } = {}): IPreviewStore {
	const now = opts.now ?? Date.now;
	const nonce = opts.nonce ?? (() => newNonce(now));
	let pending: IGraphPreview | null = null;
	const listeners = new Set<() => void>();
	const set = (next: IGraphPreview | null): void => {
		pending = next;
		listeners.forEach((listener) => listener());
	};
	return {
		get: () => pending,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		request(input) {
			const next: IGraphPreview = { nonce: nonce(), endpointKey: input.endpointKey, action: input.action, name: input.name, at: now() };
			set(next);
			return next;
		},
		consume(taken) {
			if (pending === null || pending.nonce !== taken) return false;
			set(null);
			return true;
		},
		clear() {
			if (pending !== null) set(null);
		},
	};
}

/**
 * The request a workbench should take now, if any: one for its connection, not taken in this realm, and not older
 * than the backstop.
 *
 * @param pending - The pending request.
 * @param endpointKey - The workbench's connection.
 * @param taken - Nonces this realm already took.
 * @param now - The current time (epoch ms).
 * @returns The request, or null.
 */
export function previewFor(pending: IGraphPreview | null, endpointKey: string, taken: ReadonlySet<string>, now: number): IGraphPreview | null {
	if (pending === null || pending.endpointKey !== endpointKey || taken.has(pending.nonce)) return null;
	if (now - pending.at > PREVIEW_MAX_AGE_MS) return null;
	return pending;
}

/**
 * Whether a preview can be read as one (it crossed a channel as JSON).
 *
 * @param value - Anything.
 * @returns The preview, or null.
 */
export function asPreview(value: unknown): IGraphPreview | null {
	if (value === null || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	if (typeof v.nonce !== 'string' || typeof v.endpointKey !== 'string' || typeof v.name !== 'string' || typeof v.at !== 'number') return null;
	if (v.action !== 'label-preview' && v.action !== 'type-preview') return null;
	return { nonce: v.nonce, endpointKey: v.endpointKey, action: v.action, name: v.name, at: v.at };
}
