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
// GRAPH - KEYBOARD MODEL (roving focus over the canvas, pure)
// =============================================================================
//
// One node on the canvas is tabbable at a time (the focused one); the arrow
// keys move focus to a NEIGHBOUR in that direction, and every other core action
// has a key, so the canvas is fully operable without a pointer:
//
//   Arrow keys    focus the visible neighbour closest to that direction
//   Home / End    first / last node          PageUp / PageDown   previous / next node
//   Enter         open the inspector         Space               select / deselect
//   E             expand                     C                   collapse
//   Delete        dismiss from the canvas    P                   find path (two selected)
//   (or Backspace: the key a Mac laptop labels "delete")
//   Escape        clear the selection        ?                   show these keys
//   Tab           leaves the canvas (focus is never trapped)
//
// React Flow's own keyboard handling (arrow keys MOVE the selected node; Space
// and Backspace are bound too) is turned off for this canvas (see flowProps.ts),
// so none of these conflicts with it: Backspace here is the canvas's own Dismiss.
// Keys with Ctrl, Meta or Alt are never handled, so browser and screen-reader
// shortcuts keep working.
//
// Reaching a node that no relationship connects to is what Home/End and
// PageUp/PageDown are for: the graph's connectivity is not the only way in.
// =============================================================================

import type { Point } from './geometry';
import type { IGraphModel } from './model';
import { neighborIds } from './model';
import type { GraphId } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** What a key does. */
export type KeyAction =
	| { type: 'focus'; id: GraphId }
	| { type: 'inspect'; id: GraphId }
	| { type: 'toggle-select'; id: GraphId }
	| { type: 'expand'; id: GraphId }
	| { type: 'collapse'; id: GraphId }
	| { type: 'dismiss'; id: GraphId }
	| { type: 'find-path' }
	| { type: 'clear-selection' }
	| { type: 'help' }
	| { type: 'none' };

/** The parts of a keyboard event the model reads. */
export interface IKeyInput {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
}

/** What the canvas knows when a key arrives. */
export interface IKeyContext {
	model: IGraphModel;
	/** Node centres by id (canvas units, y grows downwards). */
	positions: ReadonlyMap<GraphId, Point>;
	/** The node that has focus now, if any. */
	focusedId: GraphId | null;
}

/** An arrow key's direction vector (screen coordinates: y grows downwards). */
const ARROWS: Readonly<Record<string, Point>> = {
	ArrowUp: { x: 0, y: -1 },
	ArrowDown: { x: 0, y: 1 },
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
};

/** A neighbour must lie within this angle of the arrow's direction to be chosen. */
const CONE_RADIANS = (80 * Math.PI) / 180;

/** The documented keys, for the help text. */
export const KEY_HELP: ReadonlyArray<{ keys: string; does: string }> = [
	{ keys: 'Arrow keys', does: 'Move focus to the connected node in that direction' },
	{ keys: 'Home, End, Page Up, Page Down', does: 'Move focus to the first, last, previous or next node' },
	{ keys: 'Enter', does: 'Open the inspector for the focused node' },
	{ keys: 'Space', does: 'Select or deselect the focused node' },
	{ keys: 'E', does: 'Expand the focused node (up to 100 new neighbours)' },
	{ keys: 'C', does: 'Collapse the focused node' },
	{ keys: 'Delete or Backspace', does: 'Dismiss the focused node from the canvas' },
	{ keys: 'P', does: 'Find a path between the two selected nodes' },
	{ keys: 'Escape', does: 'Clear the selection' },
	{ keys: '?', does: 'Show these keys' },
	{ keys: 'Tab', does: 'Leave the canvas' },
];

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * What a key does on the canvas.
 *
 * @param context - The model, the layout and the focused node.
 * @param input - The key.
 * @returns The action ({@link KeyAction} `none` when the key is not ours).
 */
export function keyAction(context: IKeyContext, input: IKeyInput): KeyAction {
	if (input.ctrlKey || input.metaKey || input.altKey) return { type: 'none' };
	const { model, focusedId } = context;
	const ids = [...model.nodes.keys()];
	if (ids.length === 0) return input.key === '?' ? { type: 'help' } : { type: 'none' };
	const current = focusedId !== null && model.nodes.has(focusedId) ? focusedId : null;
	const key = input.key;

	if (key === '?') return { type: 'help' };
	if (key === 'Escape') return { type: 'clear-selection' };
	if (key === 'p' || key === 'P') return { type: 'find-path' };

	if (key === 'Home') return { type: 'focus', id: ids[0] };
	if (key === 'End') return { type: 'focus', id: ids[ids.length - 1] };
	if (key === 'PageDown' || key === 'PageUp') {
		if (current === null) return { type: 'focus', id: key === 'PageDown' ? ids[0] : ids[ids.length - 1] };
		const at = ids.indexOf(current);
		return { type: 'focus', id: ids[(at + (key === 'PageDown' ? 1 : ids.length - 1)) % ids.length] };
	}

	if (ARROWS[key] !== undefined) {
		if (current === null) return { type: 'focus', id: ids[0] };
		const next = nearestInDirection(context, current, ARROWS[key]);
		return next === null ? { type: 'none' } : { type: 'focus', id: next };
	}

	// The remaining keys act on the focused node.
	if (current === null) return { type: 'none' };
	switch (key) {
		case 'Enter':
			return { type: 'inspect', id: current };
		case ' ':
		case 'Spacebar':
			return { type: 'toggle-select', id: current };
		case 'e':
		case 'E':
			return { type: 'expand', id: current };
		case 'c':
		case 'C':
			return { type: 'collapse', id: current };
		case 'Delete':
		case 'Backspace':
			return { type: 'dismiss', id: current };
		default:
			return { type: 'none' };
	}
}

/**
 * Whether the canvas should call `preventDefault()` for an action, so the page
 * does not also scroll or react (arrow keys scroll, Space scrolls and clicks).
 *
 * @param action - What the key did.
 * @returns True for every action except `none`.
 */
export function handled(action: KeyAction): boolean {
	return action.type !== 'none';
}

/**
 * The visible neighbour of a node that lies closest to a direction, within a
 * cone around it.
 *
 * @param context - The model and layout.
 * @param from - The focused node.
 * @param direction - A direction vector.
 * @returns A neighbour id, or null when none lies that way.
 */
function nearestInDirection(context: IKeyContext, from: GraphId, direction: Point): GraphId | null {
	const origin = context.positions.get(from);
	if (!origin) return null;
	let best: GraphId | null = null;
	let bestScore = Infinity;
	for (const id of neighborIds(context.model, from)) {
		const at = context.positions.get(id);
		if (!at) continue;
		const dx = at.x - origin.x;
		const dy = at.y - origin.y;
		const length = Math.hypot(dx, dy);
		if (!(length > 1e-9)) continue;
		const cos = (dx * direction.x + dy * direction.y) / length;
		const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
		if (angle > CONE_RADIANS) continue;
		// Prefer the smallest angle; among equals, the nearest.
		const score = angle * 1000 + length;
		if (score < bestScore) {
			bestScore = score;
			best = id;
		}
	}
	return best;
}
