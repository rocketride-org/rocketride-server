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
// GRAPH - STATUS LINE (what the line under the canvas says, pure)
// =============================================================================
//
// One line replaces the notices that used to float over the canvas. It holds at
// most ONE item of each kind, so a message can only be drawn once: the
// out-of-date state, the session's notice, what is running, the canvas budget,
// the layout, a path pick, a shown path, and last the selection (or the idle
// hint). Each item is a short headline; whatever is longer sits behind "Details".
//
// The out-of-date item carries the full explanation (DATA_CHANGED_TEXT) in its
// details, and a session notice that repeats it is dropped, so the text is never
// shown twice.
// =============================================================================

import type { LayoutStatus } from '../canvas/useGraphLayout';
import { DATA_CHANGED_TEXT } from './identity';
import { GRID_NOTICE } from './wording';

// =============================================================================
// TYPES
// =============================================================================

/** What the line is built from. */
export interface IStatusInput {
	/** A write ran after the drawing. */
	stale: boolean;
	/** The session's notice. */
	notice: { variant: 'info' | 'warning' | 'error'; text: string; detail?: string } | null;
	/** The canvas budget sentence (wording.ts `canvasBudgetText`), or null. */
	budget: string | null;
	layout: LayoutStatus;
	/** The selection: how many nodes, the caption when it is one, the type when a relationship is selected. */
	selection: { count: number; caption: string | null; relationshipType: string | null };
	/** The caption of the first node of a path being picked, or null. */
	picking: string | null;
	/** Progress text of a running search, or null. */
	progress: string | null;
	/** The shown path, or null. */
	path: { nodes: readonly string[]; relationships: readonly string[] } | null;
}

/** One item of the line. */
export interface IStatusItem {
	kind: 'stale' | 'notice' | 'budget' | 'layout' | 'busy' | 'pick' | 'path' | 'selection';
	tone: 'info' | 'warning' | 'error';
	headline: string;
	/** Shown behind "Details", or null. */
	details: string | null;
}

/** The longest a headline is, so the line stays one line. */
const HEADLINE_MAX = 110;

/** The line when nothing is selected and nothing is being said. */
export const IDLE_HINT = 'Right-click a node or relationship for actions; double-click a node to expand it.';

// =============================================================================
// HEADLINES
// =============================================================================

/**
 * Split a text into a headline and the rest. Short text is all headline; long text is cut after its first sentence,
 * or, when that sentence is itself long, at a word with an ellipsis, and the rest goes behind "Details".
 *
 * @param text - Any text.
 * @param limit - The longest headline.
 * @returns The headline, and the remainder (null when there is none).
 */
export function splitHeadline(text: string, limit = HEADLINE_MAX): { headline: string; rest: string | null } {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (clean.length <= limit) return { headline: clean, rest: null };
	const sentence = /^.*?[.!?](?=\s|$)/.exec(clean);
	if (sentence && sentence[0].length <= limit && sentence[0].length < clean.length) return { headline: sentence[0], rest: clean.slice(sentence[0].length).trim() };
	const cut = clean.lastIndexOf(' ', limit - 1);
	const at = cut > limit / 2 ? cut : limit - 1;
	return { headline: `${clean.slice(0, at).trimEnd()}…`, rest: clean.slice(at).trim() };
}

/**
 * Clip a caption for use inside a headline.
 *
 * @param text - The caption.
 * @returns At most 40 characters.
 */
function clipCaption(text: string): string {
	return text.length <= 40 ? text : `${text.slice(0, 39)}…`;
}

/**
 * An item from free text.
 *
 * @param kind - The kind.
 * @param tone - The tone.
 * @param text - The text.
 * @param more - Further text for the details.
 * @returns The item.
 */
function fromText(kind: IStatusItem['kind'], tone: IStatusItem['tone'], text: string, more?: string): IStatusItem {
	const { headline, rest } = splitHeadline(text);
	const details = [rest, more].filter((part): part is string => !!part).join('\n');
	return { kind, tone, headline, details: details === '' ? null : details };
}

// =============================================================================
// ITEMS
// =============================================================================

/**
 * The items of the line, most important first.
 *
 * @param input - What is true now.
 * @returns At most one item per kind; always at least one.
 */
export function statusItems(input: IStatusInput): IStatusItem[] {
	const items: IStatusItem[] = [];
	if (input.stale) {
		items.push({ kind: 'stale', tone: 'warning', headline: 'Out of date: a write ran on this connection after this drawing. Expand, Connect and Find path are off until you run the query again.', details: DATA_CHANGED_TEXT });
	}
	if (input.notice && !(input.stale && input.notice.text === DATA_CHANGED_TEXT)) {
		items.push(fromText('notice', input.notice.variant, input.notice.text, input.notice.detail));
	}
	if (input.progress) items.push(fromText('busy', 'info', input.progress));
	if (input.budget) items.push(fromText('budget', 'info', input.budget));
	if (input.layout.state === 'fallback') items.push(fromText('layout', 'warning', `${GRID_NOTICE} (${input.layout.detail})`));
	else if (input.layout.state === 'ready' && input.layout.timedOut) items.push(fromText('layout', 'info', 'The layout stopped early to stay responsive. The positions are usable and you can drag nodes.'));
	if (input.picking !== null) items.push({ kind: 'pick', tone: 'info', headline: `Pick the second node for the path from ${clipCaption(input.picking)}. Esc cancels.`, details: null });
	if (input.path) items.push({ kind: 'path', tone: 'info', headline: `Path shown: ${input.path.nodes.length} nodes, ${input.path.relationships.length} relationships.`, details: null });
	const sel = input.selection;
	if (sel.count > 1) items.push({ kind: 'selection', tone: 'info', headline: `${sel.count} nodes selected · Shift-click adds or removes one, Esc clears`, details: null });
	else if (sel.count === 1 && sel.caption !== null) items.push({ kind: 'selection', tone: 'info', headline: `Selected: ${clipCaption(sel.caption)} · double-click to expand, right-click for more`, details: null });
	else if (sel.relationshipType !== null) items.push({ kind: 'selection', tone: 'info', headline: `Selected: :${clipCaption(sel.relationshipType)} · right-click for more`, details: null });
	else items.push({ kind: 'selection', tone: 'info', headline: IDLE_HINT, details: null });
	return items;
}
