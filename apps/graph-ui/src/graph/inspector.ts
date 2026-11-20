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

import type { IGraphModel } from './model';
import type { GraphNode, GraphRelationship } from './types';
import { decodedText, isGraphBytes, isGraphNode, isGraphNumber, isGraphPath, isGraphPoint, isGraphRelationship, isGraphTemporal, toJsonText, userEntries } from './values';

/** One row of the inspector. */
export interface IInspectorField {
	label: string;
	value: string;
	/** What kind of value was received (see {@link valueTypeOf}); for a null, a sampled schema type when one is known. */
	type: string;
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

/**
 * The kind of a property value, from the value as it was received. It describes the wire value, not the database's
 * declared type: JSON does not tell 1 from 1.0, so a whole number is "integer" and a fractional one "float"; a number
 * the node sent as text (beyond 2^53, a decimal, NaN) is "number (exact text)". A null has no kind of its own, so the
 * schema's sampled type is shown for it when there is one.
 *
 * @param value - A wire property value.
 * @param sampled - The types the schema sampled for this property of this label, if any.
 * @returns A short lower-case name.
 */
export function valueTypeOf(value: unknown, sampled?: readonly string[]): string {
	if (value === null || value === undefined) return sampled && sampled.length > 0 ? `null (schema sample: ${sampled.join(' | ')})` : 'null';
	if (typeof value === 'string') return 'string';
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float';
	if (Array.isArray(value)) return 'list';
	if (isGraphNumber(value)) return 'number (exact text)';
	if (isGraphTemporal(value)) return value.type;
	if (isGraphPoint(value)) return 'point';
	if (isGraphBytes(value)) return 'bytes';
	if (isGraphNode(value)) return 'node';
	if (isGraphRelationship(value)) return 'relationship';
	if (isGraphPath(value)) return 'path';
	return 'map';
}

/** The note shown next to every id. */
export const ID_NOTE = 'This id is a live handle, not a permanent key: it may stop pointing at the same element after the data changes, and it is only meaningful on this connection.';

/**
 * The inspector model of a node.
 *
 * @param node - A wire node.
 * @param caption - The caption the canvas shows for it.
 * @param sampledTypes - The schema's sampled types by property name for this node's label (shown only for a null value).
 * @returns The model.
 */
export function inspectNode(node: GraphNode, caption: string, sampledTypes?: ReadonlyMap<string, readonly string[]>): IInspectorModel {
	return {
		kind: 'node',
		title: caption,
		subtitle: node.labels.length > 0 ? node.labels.map((l) => `:${l}`).join('') : 'no label',
		id: node.id,
		tags: node.labels,
		fields: userEntries(node.properties).map(([label, value]) => ({ label, value: decodedText(value), type: valueTypeOf(value, sampledTypes?.get(label)) })),
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
		fields: userEntries(rel.properties).map(([label, value]) => ({ label, value: decodedText(value), type: valueTypeOf(value) })),
		json: toJsonText(rel, 2),
		endpoints: { start: rel.start, end: rel.end },
		notes: [ID_NOTE],
	};
}

/** What the inspector shows for a found path. */
export interface IPathModel {
	/** The nodes in order, each with how it is reached from the one before (null for the first). */
	steps: Array<{ id: string; caption: string; via: string | null }>;
	/** The wire JSON of the path's nodes and relationships (Copy JSON). */
	json: string;
}

/**
 * The inspector model of a found path.
 *
 * @param model - The canvas model (what is drawn).
 * @param path - The path, nodes and relationships in order.
 * @param captionOf - The caption of a drawn node.
 * @returns The steps and the JSON; elements no longer drawn are skipped in the JSON and shown by id in the steps.
 */
export function inspectPath(model: Pick<IGraphModel, 'nodes' | 'relationships'>, path: { nodes: readonly string[]; relationships: readonly string[] }, captionOf: (node: GraphNode) => string): IPathModel {
	const steps = path.nodes.map((id, i) => {
		const n = model.nodes.get(id);
		const r = i > 0 ? model.relationships.get(path.relationships[i - 1]) : undefined;
		const via = i === 0 ? null : r ? `${r.start === path.nodes[i - 1] ? '→' : '←'} :${r.type}` : '→ (relationship not drawn)';
		return { id, caption: n ? captionOf(n) : id, via };
	});
	const nodes = path.nodes.map((id) => model.nodes.get(id)).filter((n): n is GraphNode => n !== undefined);
	const relationships = path.relationships.map((id) => model.relationships.get(id)).filter((r): r is GraphRelationship => r !== undefined);
	return { steps, json: toJsonText({ nodes, relationships }, 2) };
}
