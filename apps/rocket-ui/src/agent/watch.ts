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
// WATCH — showing the agent's copy of an app while it works
// =============================================================================

/**
 * One store for the page, a module singleton like the approval feed (agentHost.ts): the host is replaced
 * on a team switch while the UI stays mounted, so this state can't live on a host. It holds:
 * - copies: the agent's open pages (appPage.ts publishes each one and retracts it when the page closes)
 * - places: elements the UI lends to show a copy over (AgentWatchSlot registers them through an AgentWatchPlace)
 * - dismissals: per copy, the places where the user pressed "Back to your preview"
 *
 * Where each copy shows is derived from those on every animation frame while a copy and a place exist.
 * A design place shows the newest copy of its app and a chat place the newest copy of its conversation.
 * Design places go first, so a chat shows a copy only while no Design area shows it. A place with no size,
 * or with something drawn over it (a modal, the Settings overlay, a drawer), shows nothing. A copy shown
 * nowhere goes back offscreen.
 *
 * The copy's iframe never moves in the DOM, because moving it reloads it. Only its cssText changes: fixed
 * over the place, still 1200x800, scaled to fit, `pointer-events:none`. The place underneath takes the
 * clicks, so the user's own preview under a design place is never driven.
 */

import { sleep } from 'shared/modules/agent/toolkits/common';
import type { AgentWatching, AgentWatchPlace } from 'shared/tools/appdev/types';
import { OFFSCREEN_STYLE, PREVIEW_SIZE } from './hiddenPreview';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The copy's stacking order: above the editor area, under popups (1000), modals (2000) and the compact drawer. */
const FRAME_Z_INDEX = 900;

/** How long each target is outlined before its action, in milliseconds, while the copy is on screen. */
const HIGHLIGHT_MS = 300;

// =============================================================================
// TYPES
// =============================================================================

/** Where a place is: the Design area of one app, or one chat's live view. */
export type PlaceKey = { readonly kind: 'design'; readonly appId: string } | { readonly kind: 'chat'; readonly conversationId: string };

/** An agent's open copy, as its page publishes it. */
export interface WatchCopy {
	readonly conversationId: string;
	readonly appId: string;
	readonly appName: string;
	readonly frame: HTMLIFrameElement;
}

/** The page's handle on its published copy. */
export interface WatchHandle {
	/** Marks this copy as the one just used: it becomes the newest for its app and its chat. */
	touch(): void;
	/** Outlines the element over the copy for HIGHLIGHT_MS, then resolves; resolves at once when the copy or the element is not in view. */
	highlight(el: Element): Promise<void>;
	/** Takes the copy out of the store and back offscreen. Safe to call again. */
	retract(): void;
}

/** Where a copy is drawn: the frame's top-left corner in the builder's viewport, and its scale. */
interface Placement {
	readonly left: number;
	readonly top: number;
	readonly scale: number;
}

interface Copy extends WatchCopy {
	/** For "newest": raised by touch(). */
	usedAt: number;
	/** The places where the user went back to their own preview, for this copy only. */
	readonly dismissed: Set<string>;
	/** What a place showing this copy says: one object, so useSyncExternalStore sees no change while it shows. */
	readonly watching: AgentWatching;
	/** The cssText last written to the frame, so an unchanged frame is not written again. */
	css: string;
}

const NO_COPIES: ReadonlySet<Copy> = new Set();

// =============================================================================
// THE STORE
// =============================================================================

class WatchStore {
	private readonly copies = new Set<Copy>();
	private readonly places = new Map<HTMLElement, PlaceKey>();
	private readonly views = new Map<string, AgentWatchPlace>();
	private readonly listeners = new Set<() => void>();
	/** Where each copy is drawn this frame; derived in tick(), read by highlight(). */
	private shown = new Map<Copy, Placement>();
	/** The copies a Design area shows this frame, which chat places leave out. */
	private inDesign: ReadonlySet<Copy> = NO_COPIES;
	private uses = 0;
	private frameRequest: number | null = null;

	publish(published: WatchCopy): WatchHandle {
		const copy: Copy = { ...published, usedAt: ++this.uses, dismissed: new Set(), watching: { appName: published.appName }, css: OFFSCREEN_STYLE };
		this.copies.add(copy);
		this.changed();
		return {
			touch: () => {
				copy.usedAt = ++this.uses;
				this.changed();
			},
			highlight: (el) => this.highlight(copy, el),
			retract: () => this.retract(copy),
		};
	}

	/** The view one place gets. Kept per key, so useSyncExternalStore gets the same functions on every render. */
	place(key: PlaceKey): AgentWatchPlace {
		const id = placeId(key);
		let view = this.views.get(id);
		if (!view) {
			view = {
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => void this.listeners.delete(listener);
				},
				watching: () => this.watched(key)?.watching ?? null,
				register: (el) => {
					this.places.set(el, key);
					this.start();
					return () => {
						this.places.delete(el);
						// step: one more frame takes the copy off the place that left
						this.start();
					};
				},
				dismiss: () => {
					const copy = this.watched(key);
					if (!copy) return;
					copy.dismissed.add(id);
					this.changed();
				},
			};
			this.views.set(id, view);
		}
		return view;
	}

	/** The copy a place of `key` shows: a chat's leaves out the copies a Design area shows. */
	private watched(key: PlaceKey): Copy | null {
		return this.newest(key, key.kind === 'chat' ? this.inDesign : NO_COPIES);
	}

	/** The newest copy of the key's app or chat that the user has not dismissed there and that is not in `taken`. */
	private newest(key: PlaceKey, taken: { has(copy: Copy): boolean }): Copy | null {
		const id = placeId(key);
		let found: Copy | null = null;
		for (const copy of this.copies) {
			const belongs = key.kind === 'design' ? copy.appId === key.appId : copy.conversationId === key.conversationId;
			if (belongs && !copy.dismissed.has(id) && !taken.has(copy) && (!found || copy.usedAt > found.usedAt)) found = copy;
		}
		return found;
	}

	private retract(copy: Copy): void {
		if (!this.copies.delete(copy)) return;
		draw(copy, undefined);
		this.shown.delete(copy);
		this.changed();
	}

	/**
	 * One frame of placement: derive, then draw. It runs from requestAnimationFrame while a copy and a place
	 * exist, so it follows a sidebar collapse, a split drag or a banner appearing, which no resize event
	 * reports, and stops otherwise.
	 */
	private tick(): void {
		this.frameRequest = null;
		const next = new Map<Copy, Placement>();
		const inDesign = new Set<Copy>();
		const designFirst = [...this.places].sort(([, a], [, b]) => Number(a.kind === 'chat') - Number(b.kind === 'chat'));
		for (const [el, key] of designFirst) {
			const rect = el.getBoundingClientRect();
			// step: a hidden tab or pane, or something drawn over the place
			if (!rect.width || !rect.height || covered(el, rect)) continue;
			const copy = this.newest(key, next);
			if (!copy) continue;
			next.set(copy, placement(rect));
			if (key.kind === 'design') inDesign.add(copy);
		}
		for (const copy of this.copies) draw(copy, next.get(copy));
		this.shown = next;
		// step: a chat's label follows whether a Design area took its copy
		const moved = inDesign.size !== this.inDesign.size || [...inDesign].some((copy) => !this.inDesign.has(copy));
		this.inDesign = inDesign;
		if (moved) this.notify();
		if (this.copies.size && this.places.size) this.start();
	}

	private async highlight(copy: Copy, el: Element): Promise<void> {
		const at = this.shown.get(copy);
		if (!at) return;
		// step: the element's box in the frame's own viewport, cut to the part the frame shows
		const box = el.getBoundingClientRect();
		const left = Math.max(box.left, 0);
		const top = Math.max(box.top, 0);
		const right = Math.min(box.right, PREVIEW_SIZE.width);
		const bottom = Math.min(box.bottom, PREVIEW_SIZE.height);
		if (right <= left || bottom <= top) return;
		// step: in the builder's body, never in the app's DOM, so no outline of the page lists it and no change check sees it
		const mark = document.createElement('div');
		mark.style.cssText = `position:fixed;left:${at.left + left * at.scale}px;top:${at.top + top * at.scale}px;width:${(right - left) * at.scale}px;height:${(bottom - top) * at.scale}px;box-sizing:border-box;border:2px solid var(--rr-brand);border-radius:3px;pointer-events:none;z-index:${FRAME_Z_INDEX + 1};`;
		document.body.appendChild(mark);
		try {
			await sleep(HIGHLIGHT_MS);
		} finally {
			mark.remove();
		}
	}

	private changed(): void {
		this.notify();
		this.start();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}

	private start(): void {
		this.frameRequest ??= requestAnimationFrame(() => this.tick());
	}
}

/** One id per place key, for the per-key views and the dismissals. */
function placeId(key: PlaceKey): string {
	return key.kind === 'design' ? `design:${key.appId}` : `chat:${key.conversationId}`;
}

/** The frame over a place: whole, centred, and never larger than its own size. */
function placement(rect: DOMRect): Placement {
	const scale = Math.min(rect.width / PREVIEW_SIZE.width, rect.height / PREVIEW_SIZE.height, 1);
	return { left: rect.left + (rect.width - PREVIEW_SIZE.width * scale) / 2, top: rect.top + (rect.height - PREVIEW_SIZE.height * scale) / 2, scale };
}

/** Puts the frame over its place, or offscreen without one. Width and height stay 1200x800, so the app never lays out again. */
function draw(copy: Copy, at: Placement | undefined): void {
	const css = at ? `position:fixed;left:${at.left}px;top:${at.top}px;width:${PREVIEW_SIZE.width}px;height:${PREVIEW_SIZE.height}px;border:none;transform:scale(${at.scale});transform-origin:0 0;pointer-events:none;z-index:${FRAME_Z_INDEX};` : OFFSCREEN_STYLE;
	if (css === copy.css) return;
	copy.css = css;
	copy.frame.style.cssText = css;
}

/**
 * Whether something is drawn over the place: the topmost element at its centre is neither the place nor
 * inside it. Hit testing skips the copies (`pointer-events:none`), so this needs no z-index of a modal,
 * the Settings overlay or a drawer. A centre outside the window counts as covered.
 */
function covered(el: HTMLElement, rect: DOMRect): boolean {
	const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
	return !hit || !el.contains(hit);
}

const store = new WatchStore();

/** Publishes an open copy (appPage.ts only). */
export function publishWatch(copy: WatchCopy): WatchHandle {
	return store.publish(copy);
}

/** A place's view of the store: webHost.ts gets the Design place of its app, agentHost.ts a chat's. */
export function watchPlace(key: PlaceKey): AgentWatchPlace {
	return store.place(key);
}
