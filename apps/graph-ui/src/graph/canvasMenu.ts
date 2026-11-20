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
// GRAPH - CANVAS MENU (items, keys and placement, pure)
// =============================================================================
//
// What the right-click menu offers for a node, a relationship or the empty
// canvas, how the keyboard drives it (the WAI-ARIA authoring practices menu:
// Down and Up with wrap, Home and End, Enter and Space, Right into a submenu
// and Left back, Escape, Tab, and a letter to jump), and where it is placed so
// it never runs past the canvas. The component (components/CanvasMenu.tsx)
// only draws this and moves focus.
//
// Every item that asks the database is off while something is running or the
// drawing is out of date, and says why in its title, so the menu never offers
// what the session would refuse.
// =============================================================================

import type { CanvasMenuTarget } from '../canvas/GraphCanvas';
import type { ISchemaView } from './schema';

// =============================================================================
// TYPES
// =============================================================================

/** One item of a menu. */
export interface IMenuItem {
	/** What the owner switches on. Types in "Expand by type" are `type:<name>`. */
	id: string;
	label: string;
	/** The key or gesture that does the same, shown at the right. */
	hint?: string;
	disabled?: boolean;
	/** Why it is off. */
	reason?: string;
	/** `menuitemradio` and `menuitemcheckbox` carry `checked`. */
	role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
	checked?: boolean;
	/** Items shown in place of the menu when this one is opened. */
	submenu?: readonly IMenuItem[];
	/** A rule is drawn above it. */
	separatorBefore?: boolean;
}

/** What the menu needs to know to decide what is on. */
export interface IMenuContext {
	/** Something is running (an expansion, Connect, a path search, a refresh). */
	busy: boolean;
	/** A write ran after the drawing. */
	stale: boolean;
	selectedCount: number;
	nodeCount: number;
	/** A "New query from here" text exists for the target. */
	canQuery: boolean;
	/** The relationship types to offer under "Expand by type" (see {@link relationshipTypesFor}). */
	relationshipTypes: readonly string[];
	/** Whether a relationship's ends are drawn (relationship menus). */
	startDrawn?: boolean;
	endDrawn?: boolean;
}

/** What one key does in an open menu. `handled`: the key was the menu's, so its default is prevented. */
export type MenuKeyResult =
	| { type: 'move'; index: number; handled: true }
	| { type: 'activate'; index: number; handled: true }
	| { type: 'open-submenu'; index: number; handled: true }
	| { type: 'back'; handled: true }
	| { type: 'close'; handled: boolean }
	| { type: 'none'; handled: boolean };

const BUSY_REASON = 'Wait for the running action to finish, or stop waiting.';
const STALE_REASON = 'Out of date: run the query again first.';
const NO_TYPES_REASON = 'No relationship type is known for this label. The list comes from the schema, which is sampled.';

// =============================================================================
// ITEMS
// =============================================================================

/**
 * The items of a menu.
 *
 * @param target - What was right-clicked.
 * @param context - What is true now.
 * @returns The items, in order.
 */
export function menuItemsFor(target: CanvasMenuTarget, context: IMenuContext): IMenuItem[] {
	const asks = (item: IMenuItem): IMenuItem => (context.busy ? { ...item, disabled: true, reason: BUSY_REASON } : context.stale ? { ...item, disabled: true, reason: STALE_REASON } : item);
	if (target.kind === 'pane') {
		return [
			{ id: 'fit', label: 'Fit to screen', hint: 'F' },
			{ id: 'relayout', label: 'Re-run layout' },
			{ id: 'clear-selection', label: 'Clear selection', hint: 'Esc', ...(context.selectedCount === 0 ? { disabled: true, reason: 'Nothing is selected.' } : {}) },
		];
	}
	if (target.kind === 'relationship') {
		const items: IMenuItem[] = [
			{ id: 'inspect', label: 'Inspect' },
			{ id: 'select-start', label: 'Select start node', ...(context.startDrawn === false ? { disabled: true, reason: 'This end is not drawn.' } : {}) },
			{ id: 'select-end', label: 'Select end node', ...(context.endDrawn === false ? { disabled: true, reason: 'This end is not drawn.' } : {}) },
		];
		if (context.canQuery) items.push({ id: 'new-query', label: 'New query from here', separatorBefore: true });
		return items;
	}
	const types: IMenuItem = context.relationshipTypes.length === 0 ? { id: 'expand-type', label: 'Expand by type (sampled)', disabled: true, reason: NO_TYPES_REASON } : { id: 'expand-type', label: 'Expand by type (sampled)', submenu: context.relationshipTypes.map((type) => ({ id: `type:${type}`, label: type })) };
	const items: IMenuItem[] = [
		asks({ id: 'expand', label: 'Expand all neighbours', hint: 'double-click · E' }),
		asks(types),
		{ id: 'collapse', label: 'Collapse', hint: 'C' },
		{ id: 'dismiss', label: 'Dismiss', hint: 'Del' },
		{ id: 'inspect', label: 'Inspect', hint: 'Enter' },
		asks({ id: 'find-path', label: 'Find path to…', hint: 'P', separatorBefore: true }),
		asks({ id: 'connect', label: 'Connect the drawn nodes', ...(context.nodeCount < 2 ? { disabled: true, reason: 'Needs two or more drawn nodes.' } : {}) }),
		{ id: 'copy-caption', label: 'Copy caption', separatorBefore: true },
		{ id: 'copy-json', label: 'Copy as JSON' },
	];
	if (context.canQuery) items.push({ id: 'new-query', label: 'New query from here' });
	return items;
}

/**
 * The relationship types to offer for a node: those the schema says can start or end at one of its labels.
 *
 * @param schema - The connection's schema view, or null when it is not loaded.
 * @param labels - The node's labels.
 * @returns Type names, sorted; empty when the schema is unknown.
 */
export function relationshipTypesFor(schema: Pick<ISchemaView, 'relationshipTypes'> | null, labels: readonly string[]): string[] {
	if (!schema) return [];
	const mine = new Set(labels);
	return schema.relationshipTypes
		.filter((t) => t.endpoints.some((e) => mine.has(e.start) || mine.has(e.end)))
		.map((t) => t.type)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// =============================================================================
// KEYS
// =============================================================================

/**
 * What a key does in an open menu.
 *
 * @param items - The items shown.
 * @param index - The current item.
 * @param key - `KeyboardEvent.key`.
 * @returns The action.
 */
export function menuKey(items: readonly IMenuItem[], index: number, key: string): MenuKeyResult {
	const count = items.length;
	if (key === 'Escape') return { type: 'close', handled: true };
	if (key === 'Tab') return { type: 'close', handled: false };
	if (key === 'ArrowLeft') return { type: 'back', handled: true };
	if (count === 0) return { type: 'none', handled: key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' || key === 'Enter' || key === ' ' };
	const item = items[index];
	switch (key) {
		case 'ArrowDown':
			return { type: 'move', index: (index + 1) % count, handled: true };
		case 'ArrowUp':
			return { type: 'move', index: (index - 1 + count) % count, handled: true };
		case 'Home':
			return { type: 'move', index: 0, handled: true };
		case 'End':
			return { type: 'move', index: count - 1, handled: true };
		case 'ArrowRight':
			return item?.submenu && !item.disabled ? { type: 'open-submenu', index, handled: true } : { type: 'none', handled: false };
		case 'Enter':
		case ' ':
			if (!item || item.disabled) return { type: 'none', handled: true };
			return item.submenu ? { type: 'open-submenu', index, handled: true } : { type: 'activate', index, handled: true };
		default:
			break;
	}
	if (Array.from(key).length === 1 && /\S/.test(key)) {
		const letter = key.toLowerCase();
		for (let step = 1; step <= count; step++) {
			const at = (index + step) % count;
			if (items[at].label.toLowerCase().startsWith(letter)) return { type: 'move', index: at, handled: true };
		}
	}
	return { type: 'none', handled: false };
}

// =============================================================================
// PLACEMENT
// =============================================================================

/**
 * Where to put a menu so it stays inside its container.
 *
 * @param at - Where it was asked for, relative to the container.
 * @param bounds - The container's size.
 * @param size - The menu's size.
 * @param margin - The room kept at every edge.
 * @returns The top-left of the menu.
 */
export function clampMenuPosition(at: { x: number; y: number }, bounds: { width: number; height: number }, size: { width: number; height: number }, margin = 4): { x: number; y: number } {
	return {
		x: Math.max(margin, Math.min(at.x, bounds.width - size.width - margin)),
		y: Math.max(margin, Math.min(at.y, bounds.height - size.height - margin)),
	};
}

/**
 * How far to move a menu so it lies inside the viewport (the window, which a maximised document fills too). It moves
 * left or up by what overflows the right or bottom edge, then right or down if that pushed it past the left or top.
 *
 * @param rect - Where the menu is now, in viewport coordinates.
 * @param viewport - The viewport's size.
 * @param margin - The room kept at every edge.
 * @returns The shift to apply.
 */
export function fitInViewport(rect: { left: number; top: number; width: number; height: number }, viewport: { width: number; height: number }, margin = 4): { dx: number; dy: number } {
	const shift = (start: number, size: number, limit: number): number => {
		let d = 0;
		if (start + size > limit - margin) d = limit - margin - (start + size);
		if (start + d < margin) d = margin - start;
		return d;
	};
	return { dx: shift(rect.left, rect.width, viewport.width), dy: shift(rect.top, rect.height, viewport.height) };
}
