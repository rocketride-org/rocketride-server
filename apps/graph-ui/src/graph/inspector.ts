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
// GRAPH - INSPECTOR MODEL (what the detail panel shows for a node or relationship)
// =============================================================================
//
// Pure: turns a wire node or relationship into the fields, JSON and notes the
// inspector renders. Property keys are shown as the user wrote them (one leading
// `@` removed), and so are the keys of maps nested in a value, at any depth;
// values are shown in full and exactly (a number tag is its text, never a rounded
// float); Copy-as-JSON is the WIRE form, so what is copied can be pasted back into
// a test or a bug report without losing a digit.
//
// An element id is a LIVE HANDLE: Neo4j's elementId in particular is not stable
// across transactions, and AGE and FalkorDB may reuse an id after a delete. The
// panel says so wherever it shows an id, and never offers the id as a permanent
// link.
// =============================================================================

import type { GraphNode, GraphRelationship } from './types';
import { decodedText, toJsonText, userEntries } from './values';

/** One row of the inspector. */
export interface IInspectorField {
	label: string;
	value: string;
}

/** What the inspector shows. */
export interface IInspectorModel {
	kind: 'node' | 'relationship';
	title: string;
	subtitle: string;
	id: string;
	/** Labels (node) or the single type (relationship). */
	tags: string[];
	/** Properties, in wire order, keys decoded. */
	fields: IInspectorField[];
	/** The wire JSON of the entity (Copy as JSON). */
	json: string;
	/** Start and end ids (relationship only), as stored. */
	endpoints: { start: string; end: string } | null;
	/** Sentences qualifying what is shown. */
	notes: string[];
}

/** The note shown next to every id. */
export const ID_NOTE = 'This id is a live handle, not a permanent key: it may stop pointing at the same element after the data changes, and it is only meaningful on this connection.';

/**
 * The inspector model of a node.
 *
 * @param node - A wire node.
 * @param caption - The caption the canvas shows for it.
 * @returns The model.
 */
export function inspectNode(node: GraphNode, caption: string): IInspectorModel {
	return {
		kind: 'node',
		title: caption,
		subtitle: node.labels.length > 0 ? node.labels.map((l) => `:${l}`).join('') : 'no label',
		id: node.id,
		tags: node.labels,
		fields: userEntries(node.properties).map(([label, value]) => ({ label, value: decodedText(value) })),
		json: toJsonText(node, 2),
		endpoints: null,
		notes: [ID_NOTE],
	};
}

/**
 * The inspector model of a relationship.
 *
 * @param rel - A wire relationship.
 * @param captionOf - The caption of a node id (or the id itself when it is not drawn).
 * @returns The model.
 */
export function inspectRelationship(rel: GraphRelationship, captionOf: (id: string) => string): IInspectorModel {
	return {
		kind: 'relationship',
		title: `:${rel.type}`,
		subtitle: `${captionOf(rel.start)} → ${captionOf(rel.end)} (as stored)`,
		id: rel.id,
		tags: [rel.type],
		fields: userEntries(rel.properties).map(([label, value]) => ({ label, value: decodedText(value) })),
		json: toJsonText(rel, 2),
		endpoints: { start: rel.start, end: rel.end },
		notes: [ID_NOTE],
	};
}
