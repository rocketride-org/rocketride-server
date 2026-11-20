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
// GRAPH - SCHEMA LIST MODEL (what the sidebar lists, and how keys move in it)
// =============================================================================
//
// The sidebar draws the active connection's schema as its own list
// (components/SchemaList.tsx): node labels and relationship types, each a row
// with its colour, name and count, and a disclosure for what the schema holds
// about it (a label's properties with their observed types; a type's start and
// end labels and its properties).
//
// A label or relationship type is user data: it can hold `/`, be empty, look
// like an id, or repeat across sections. So no name is ever put into an id:
// each row is addressed by its position (`L00007`, `R00002`), zero-padded so
// the order is the schema's, and carries its real name for every action.
//
// Keys follow the WAI-ARIA tree pattern (listKeyAction): Up and Down move,
// Home and End jump, Right opens a row (then moves into it), Left closes it
// (or goes from a detail to its row), Enter previews, and Shift+F10 or the
// Menu key opens the row's menu (menuItemsFor). A preview is the user's
// explicit request for the generated 25-row query; a new query with the label
// or type puts the same text in a new tab without running it.
// =============================================================================

import type { GraphDialect } from '../cypher/quote';
import { quoteIdentifier } from '../cypher/quote';
import { countText } from './schema';
import type { ISchemaProperty, ISchemaView } from './schema';

// =============================================================================
// ROWS
// =============================================================================

/** One line under an open row: a property and its types, or a start and end pair. */
export interface ISchemaDetail {
	name: string;
	/** The property's observed types, or whether the pair was seen or inferred. */
	detail: string;
}

/** One label or relationship type. */
export interface ISchemaRow {
	/** Position-based (`L00000`, `R00000`): never the name. */
	id: string;
	kind: 'label' | 'type';
	/** The real name, exactly as the schema holds it. */
	name: string;
	/** The name made safe to show on one line ({@link shown}). */
	text: string;
	/** `about 1,200`, `7`, or '' when the count is not reported. */
	count: string;
	details: ISchemaDetail[];
}

/** The sidebar's two sections. */
export interface ISchemaList {
	labels: ISchemaRow[];
	types: ISchemaRow[];
}

/**
 * A property's observed types as the sidebar prints them.
 *
 * @param property - The property.
 * @returns `string`, `string, integer`, or `unknown` when none were seen.
 */
export function typesText(property: ISchemaProperty): string {
	return property.types.length === 0 ? 'unknown' : property.types.join(', ');
}

/**
 * A name made safe to show in one line: control characters become spaces and a long name is cut (the row keeps the
 * full name for every action).
 *
 * @param name - A label, type or property name.
 * @returns Printable text; `(empty name)` for ''.
 */
export function shown(name: string): string {
	if (name === '') return '(empty name)';
	let out = '';
	for (const ch of name) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? ' ' : ch;
	}
	return out.length > 80 ? `${out.slice(0, 79)}\u2026` : out;
}

const pad = (n: number): string => String(n).padStart(5, '0');

/**
 * Build the sidebar's list for a schema.
 *
 * @param view - The parsed schema.
 * @returns The rows, in the schema's order.
 */
export function buildSchemaList(view: ISchemaView): ISchemaList {
	return {
		labels: view.labels.map((label, i) => ({
			id: `L${pad(i)}`,
			kind: 'label',
			name: label.name,
			text: shown(label.name),
			count: countText(label.count, label.countEstimated),
			details: label.properties.map((p) => ({ name: shown(p.name), detail: typesText(p) })),
		})),
		types: view.relationshipTypes.map((type, i) => ({
			id: `R${pad(i)}`,
			kind: 'type',
			name: type.type,
			text: shown(type.type),
			count: countText(type.count, type.countEstimated),
			details: [
				...type.endpoints.map((e) => ({ name: `${shown(e.start)} \u2192 ${shown(e.end)}`, detail: e.observed ? 'seen' : 'inferred' })),
				...type.properties.map((p) => ({ name: shown(p.name), detail: typesText(p) })),
			],
		})),
	};
}

/**
 * What the sidebar says when counts are missing (Apache AGE reports none for a table that was never analysed), so a
 * row without a count never reads as zero.
 *
 * @param view - The parsed schema.
 * @returns `Counts not reported.`, `Some counts not reported.`, or null when every label and type has one.
 */
export function countsNote(view: ISchemaView): string | null {
	const items = [...view.labels, ...view.relationshipTypes];
	const missing = items.filter((item) => item.count === null).length;
	if (missing === 0) return null;
	return missing === items.length ? 'Counts not reported.' : 'Some counts not reported.';
}

// =============================================================================
// KEYS
// =============================================================================

/** A visible item: a row, or one detail of an open row. */
export interface ISchemaListItem {
	row: number;
	/** The detail's index, or null for the row itself. */
	detail: number | null;
}

/** What a key does in the list. */
export type SchemaListAction = { focus: ISchemaListItem } | { toggle: string } | { activate: number } | { menu: number };

/**
 * The items on screen, in order: each row, and an open row's details right under it.
 *
 * @param rows - The section's rows.
 * @param expanded - The ids of the open rows.
 * @returns The items.
 */
export function visibleItems(rows: readonly ISchemaRow[], expanded: ReadonlySet<string>): ISchemaListItem[] {
	const items: ISchemaListItem[] = [];
	rows.forEach((row, index) => {
		items.push({ row: index, detail: null });
		if (expanded.has(row.id)) row.details.forEach((_, detail) => items.push({ row: index, detail }));
	});
	return items;
}

/**
 * What a key does on the focused item (the WAI-ARIA tree pattern).
 *
 * @param event - The key and whether Shift was held.
 * @param event.key - The key.
 * @param event.shiftKey - Shift.
 * @param at - The focused item.
 * @param rows - The section's rows.
 * @param expanded - The ids of the open rows.
 * @returns The action, or null when the key is not the list's.
 */
export function listKeyAction(event: { key: string; shiftKey: boolean }, at: ISchemaListItem, rows: readonly ISchemaRow[], expanded: ReadonlySet<string>): SchemaListAction | null {
	const items = visibleItems(rows, expanded);
	const index = Math.max(0, items.findIndex((item) => item.row === at.row && item.detail === at.detail));
	const row = rows[at.row];
	if (!row) return null;
	const onRow = at.detail === null;
	switch (event.key) {
		case 'ArrowDown':
			return { focus: items[Math.min(items.length - 1, index + 1)] };
		case 'ArrowUp':
			return { focus: items[Math.max(0, index - 1)] };
		case 'Home':
			return { focus: items[0] };
		case 'End':
			return { focus: items[items.length - 1] };
		case 'ArrowRight':
			if (!onRow || row.details.length === 0) return null;
			return expanded.has(row.id) ? { focus: { row: at.row, detail: 0 } } : { toggle: row.id };
		case 'ArrowLeft':
			if (!onRow) return { focus: { row: at.row, detail: null } };
			return expanded.has(row.id) ? { toggle: row.id } : null;
		case 'Enter':
			return onRow ? { activate: at.row } : null;
		case 'F10':
			return onRow && event.shiftKey ? { menu: at.row } : null;
		case 'ContextMenu':
			return onRow ? { menu: at.row } : null;
		default:
			return null;
	}
}

// =============================================================================
// THE ROW MENU
// =============================================================================

/** One item of a row's menu. */
export interface ISchemaMenuItem {
	id: 'preview' | 'query' | 'copy-name' | 'copy-pattern';
	label: string;
	/** True when it cannot be done for this name (it is then not offered as an action). */
	disabled: boolean;
}

/**
 * A label or relationship type as a Cypher pattern, quoted the way the connection's engine quotes a name.
 *
 * @param kind - Label or relationship type.
 * @param name - The real name.
 * @param dialect - The connection's engine, or null when it has not answered.
 * @returns `(:Person)` or `()-[:KNOWS]->()` (quoted), or null when the name cannot be written for this engine.
 */
export function patternText(kind: 'label' | 'type', name: string, dialect: GraphDialect | null): string | null {
	const quoted = dialect === null ? null : quoteIdentifier(name, dialect);
	if (quoted === null) return null;
	return kind === 'label' ? `(:${quoted})` : `()-[:${quoted}]->()`;
}

/**
 * A row's menu.
 *
 * @param kind - Label or relationship type.
 * @param name - The real name.
 * @param dialect - The connection's engine, or null.
 * @returns The items, in order.
 */
export function menuItemsFor(kind: 'label' | 'type', name: string, dialect: GraphDialect | null): ISchemaMenuItem[] {
	return [
		{ id: 'preview', label: 'Preview 25 in a new tab', disabled: false },
		{ id: 'query', label: kind === 'label' ? 'New query with this label' : 'New query with this type', disabled: false },
		{ id: 'copy-name', label: 'Copy name', disabled: false },
		{ id: 'copy-pattern', label: 'Copy as pattern', disabled: patternText(kind, name, dialect) === null },
	];
}

/** What a key does in an open row menu. */
export type SchemaMenuAction = { focus: number } | { choose: number } | { close: 'escape' | 'tab' };

/**
 * What a key does in a row's menu (the WAI-ARIA menu pattern): Up and Down move and wrap, past items that cannot be
 * chosen; Home and End jump; Enter and Space choose; Escape closes (focus back on the row); Tab closes.
 *
 * @param key - The key.
 * @param at - The focused item's index.
 * @param items - The menu's items.
 * @returns The action, or null when the key is not the menu's.
 */
export function menuKeyAction(key: string, at: number, items: readonly ISchemaMenuItem[]): SchemaMenuAction | null {
	const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0);
	if (enabled.length === 0) return key === 'Escape' ? { close: 'escape' } : key === 'Tab' ? { close: 'tab' } : null;
	const position = enabled.indexOf(at);
	switch (key) {
		case 'ArrowDown':
			return { focus: enabled[(position + 1) % enabled.length] };
		case 'ArrowUp':
			return { focus: enabled[(position - 1 + enabled.length) % enabled.length] };
		case 'Home':
			return { focus: enabled[0] };
		case 'End':
			return { focus: enabled[enabled.length - 1] };
		case 'Enter':
		case ' ':
			return position >= 0 ? { choose: at } : null;
		case 'Escape':
			return { close: 'escape' };
		case 'Tab':
			return { close: 'tab' };
		default:
			return null;
	}
}
