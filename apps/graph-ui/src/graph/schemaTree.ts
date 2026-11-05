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
// GRAPH - SCHEMA TREE MODEL (what the sidebar lists)
// =============================================================================
//
// The shell's stock Explorer draws a tree from `{path, children}` entries and derives
// its folders from the path, S3-style. A label or relationship type is user data: it
// can hold `/`, be empty, look like a path, or repeat across sections. So no name is
// ever put into a path. Each entry gets a position-based path
// (`Node labels/L00007`) and the Explorer's display-name hook and the click handler
// look the real name up here. Positions are zero-padded so the Explorer's own sort
// keeps the schema's order.
//
// Children are the facts the schema holds: a label's properties with their observed
// types, a relationship type's start/end labels and properties. Clicking an entry is
// the user's explicit request for the generated 25-row preview: the query is shown in
// the editor and sent through `read_query`, so it is a read like any other.
// =============================================================================

import type { ExplorerEntry } from 'shell';
import { countText } from './schema';
import type { ISchemaProperty, ISchemaView } from './schema';

/** The section folder names. */
export const LABELS_SECTION = 'Node labels';
export const TYPES_SECTION = 'Relationship types';

/** What a tree entry stands for. */
export interface ISchemaTreeTarget {
	kind: 'label' | 'type';
	/** The real name, exactly as the schema holds it. */
	name: string;
}

/** The tree for the Explorer, and the lookups it needs. */
export interface ISchemaTree {
	entries: ExplorerEntry[];
	/** The text shown for a file name in the tree (`Person (about 1,200)`). */
	displayName(filename: string): string;
	/** What a clicked path stands for, or null for a folder or an unknown path. */
	target(path: string): ISchemaTreeTarget | null;
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
 * A name made safe to show in one line of the tree: control characters become
 * spaces and a long name is cut (the full name stays in the tooltip-free lookup).
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
 * Build the Explorer tree for a schema.
 *
 * @param view - The parsed schema.
 * @returns The tree and its lookups.
 */
export function buildSchemaTree(view: ISchemaView): ISchemaTree {
	const names = new Map<string, string>();
	const targets = new Map<string, ISchemaTreeTarget>();
	const entries: ExplorerEntry[] = [];

	view.labels.forEach((label, i) => {
		const file = `L${pad(i)}`;
		const path = `${LABELS_SECTION}/${file}`;
		const count = countText(label.count, label.countEstimated);
		names.set(file, `${shown(label.name)}${count ? ` (${count})` : ''}`);
		targets.set(path, { kind: 'label', name: label.name });
		entries.push({
			path,
			type: 'file',
			children: label.properties.map((p, j) => ({ id: `${file}:${pad(j)}`, name: shown(p.name), provider: typesText(p) })),
		});
	});

	view.relationshipTypes.forEach((type, i) => {
		const file = `R${pad(i)}`;
		const path = `${TYPES_SECTION}/${file}`;
		const count = countText(type.count, type.countEstimated);
		names.set(file, `${shown(type.type)}${count ? ` (${count})` : ''}`);
		targets.set(path, { kind: 'type', name: type.type });
		entries.push({
			path,
			type: 'file',
			children: [
				...type.endpoints.map((e, j) => ({ id: `${file}:e${pad(j)}`, name: `${shown(e.start)} \u2192 ${shown(e.end)}`, provider: e.observed ? 'seen' : 'inferred' })),
				...type.properties.map((p, j) => ({ id: `${file}:p${pad(j)}`, name: shown(p.name), provider: typesText(p) })),
			],
		});
	});

	return {
		entries,
		displayName: (filename) => names.get(filename) ?? filename,
		target: (path) => targets.get(path) ?? null,
	};
}
