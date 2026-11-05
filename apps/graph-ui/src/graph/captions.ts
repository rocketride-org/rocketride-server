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
// GRAPH - CAPTIONS (what a node shows as its name on the canvas)
// =============================================================================
//
// A node's caption is one of its properties, chosen per LABEL (the caption
// picker), or - when nothing was chosen - the first sensible property it has.
// Two special choices exist: the node's id and its first label. The choice
// belongs to the user and to the connection; this module only turns a node and a
// choice into text and lists what can be chosen.
// =============================================================================

import type { GraphNode } from './types';
import { clip, decodeUserKey, describeValue, isGraphNumber } from './values';

/** Pick the element id as the caption. */
export const CAPTION_ID = '<id>';

/** Pick the node's first label as the caption. */
export const CAPTION_LABEL = '<label>';

/** Property names tried, in order, when no caption was chosen. */
export const DEFAULT_CAPTION_KEYS = ['name', 'title', 'label', 'caption', 'fullname', 'username', 'email', 'id', 'key'] as const;

/** Captions longer than this are cut with an ellipsis. */
export const CAPTION_MAX_CHARS = 28;

/** What the caption picker can offer for one label. */
export interface ICaptionChoice {
	/** The value stored as the choice: a property name, {@link CAPTION_ID} or {@link CAPTION_LABEL}. */
	value: string;
	/** Text for the picker. */
	label: string;
}

/**
 * The property a node shows when nothing was chosen.
 *
 * @param node - A node.
 * @returns A property name, {@link CAPTION_LABEL} when it has a label, else {@link CAPTION_ID}.
 */
export function defaultCaptionKey(node: GraphNode): string {
	const keys = Object.keys(node.properties).map(decodeUserKey);
	const lower = new Map(keys.map((k) => [k.toLowerCase(), k] as const));
	for (const candidate of DEFAULT_CAPTION_KEYS) {
		const found = lower.get(candidate);
		if (found !== undefined && isShowable(valueOf(node, found))) return found;
	}
	for (const key of [...keys].sort()) if (typeof valueOf(node, key) === 'string' && (valueOf(node, key) as string).length > 0) return key;
	return node.labels.length > 0 ? CAPTION_LABEL : CAPTION_ID;
}

/**
 * A property value by DECODED key (the wire key carries one extra `@` when the
 * user's key starts with `@`).
 *
 * @param node - A node.
 * @param key - A decoded property name.
 * @returns The value, or undefined.
 */
function valueOf(node: GraphNode, key: string): unknown {
	for (const wire of Object.keys(node.properties)) if (decodeUserKey(wire) === key) return node.properties[wire];
	return undefined;
}

/**
 * Whether a value makes a readable caption.
 *
 * @param value - A property value.
 * @returns True for a non-empty string, a number or a number tag.
 */
function isShowable(value: unknown): boolean {
	return (typeof value === 'string' && value.length > 0) || typeof value === 'number' || isGraphNumber(value);
}

/**
 * The caption text for a node.
 *
 * @param node - A node.
 * @param choice - The user's choice for the node's label, or undefined for the default.
 * @returns Bounded single-line text (never empty).
 */
export function captionOf(node: GraphNode, choice?: string): string {
	let key = choice ?? defaultCaptionKey(node);
	let text: string | null = null;
	for (let pass = 0; pass < 2 && text === null; pass++) {
		if (key === CAPTION_ID) text = node.id;
		else if (key === CAPTION_LABEL) text = node.labels[0] ?? null;
		else {
			const value = valueOf(node, key);
			text = value === undefined || value === null ? null : describeValue(value);
		}
		if (text === null || text === '') {
			text = null;
			// The chosen property is missing on this node: use the default for it.
			key = defaultCaptionKey(node);
		}
	}
	return clip((text ?? node.id).replace(/\s+/g, ' ').trim() || node.id, CAPTION_MAX_CHARS);
}

/**
 * The choices to offer for a label, from the nodes of that label that are drawn:
 * their property names (most common first, then alphabetical), then the two
 * special choices.
 *
 * @param nodes - Drawn nodes carrying the label.
 * @returns The choices.
 */
export function captionChoices(nodes: readonly GraphNode[]): ICaptionChoice[] {
	const counts = new Map<string, number>();
	for (const node of nodes) for (const wire of Object.keys(node.properties)) counts.set(decodeUserKey(wire), (counts.get(decodeUserKey(wire)) ?? 0) + 1);
	const keys = [...counts.keys()].sort((a, b) => (counts.get(b) as number) - (counts.get(a) as number) || (a < b ? -1 : a > b ? 1 : 0));
	return [...keys.map((key) => ({ value: key, label: key })), { value: CAPTION_LABEL, label: '(label)' }, { value: CAPTION_ID, label: '(id)' }];
}
