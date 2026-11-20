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
// GRAPH - ELEMENT IDENTITY (is the element the database returned the one drawn?)
// =============================================================================
//
// Element ids are LIVE HANDLES, not identities. A database may hand an id out again
// once the element that held it is gone: FalkorDB reuses ids after a delete (measured:
// CREATE, DELETE, CREATE gives the new node the old id), and Apache AGE ids are
// per-label sequences. So "the answer contains id 7" does not mean "this is the node
// I drew as 7".
//
// The canvas therefore never merges an answer into drawn elements without checking
// that each element it already holds comes back as the same KIND of thing:
//
//   node          the same set of labels
//   relationship  the same type, the same start id and the same end id
//
// Anything else is a different element that happens to share an id, and merging it
// would paint an unrelated entity over a drawn one and keep the old relationships
// attached to it. Properties are allowed to differ (a refresh is meant to show them).
// This is a guard, not a proof: a recreated element with the same labels (or the
// same type and ends) cannot be told apart from here, which is why a write that ran
// on the connection marks the whole drawing out of date as well (see graphSession).
// =============================================================================

import type { IGraphModel } from './model';
import type { GraphId, GraphNode, GraphRelationship } from './types';

/** One element whose returned form is not the drawn one. */
export interface IIdentityConflict {
	id: GraphId;
	kind: 'node' | 'relationship';
	/** What the canvas holds under the id, in words (`labels Person`, `type KNOWS from 1 to 2`). */
	drawn: string;
	/** What the database returned under it. */
	returned: string;
}

/**
 * The labels of a node as a comparable text (order does not matter).
 *
 * @param node - A node.
 * @returns A string that is equal for equal label sets.
 */
function labelKey(node: GraphNode): string {
	return JSON.stringify([...node.labels].sort());
}

/**
 * A node's labels in words.
 *
 * @param node - A node.
 * @returns `labels A, B` or `no label`.
 */
function labelWords(node: GraphNode): string {
	return node.labels.length === 0 ? 'no label' : `label${node.labels.length === 1 ? '' : 's'} ${node.labels.join(', ')}`;
}

/**
 * A relationship's type and ends in words.
 *
 * @param rel - A relationship.
 * @returns `type KNOWS from 1 to 2`.
 */
function relWords(rel: GraphRelationship): string {
	return `type ${rel.type} from ${rel.start} to ${rel.end}`;
}

/**
 * Every returned element that shares an id with a drawn one but is not the same element.
 *
 * @param model - What the canvas draws.
 * @param nodes - Nodes the database returned.
 * @param relationships - Relationships the database returned.
 * @returns The conflicts (none means the answer may be merged).
 */
export function identityConflicts(model: Pick<IGraphModel, 'nodes' | 'relationships'>, nodes: Iterable<GraphNode>, relationships: Iterable<GraphRelationship>): IIdentityConflict[] {
	const out: IIdentityConflict[] = [];
	for (const returned of nodes) {
		const drawn = model.nodes.get(returned.id);
		if (drawn && labelKey(drawn) !== labelKey(returned)) out.push({ id: returned.id, kind: 'node', drawn: labelWords(drawn), returned: labelWords(returned) });
	}
	for (const returned of relationships) {
		const drawn = model.relationships.get(returned.id);
		if (drawn && (drawn.type !== returned.type || drawn.start !== returned.start || drawn.end !== returned.end)) out.push({ id: returned.id, kind: 'relationship', drawn: relWords(drawn), returned: relWords(returned) });
	}
	return out;
}

/**
 * The sentence for an answer that was not merged.
 *
 * @param conflicts - What did not match (at least one).
 * @returns Text for the notice.
 */
export function conflictText(conflicts: readonly IIdentityConflict[]): string {
	const n = conflicts.length;
	const first = conflicts[0];
	const what = first.kind === 'node' ? 'node' : 'relationship';
	return `The database returned ${n === 1 ? 'a different element' : `${n} different elements`} under ${n === 1 ? 'an id' : 'ids'} drawn here (the ${what} ${first.id} was ${first.drawn}, and is now ${first.returned}). Ids can be reused after a delete, so nothing from this answer was added, and the drawn ${n === 1 ? 'copy is' : 'copies are'} marked out of date. Dismiss ${n === 1 ? 'it' : 'them'}, or run the query again.`;
}

/** Said when a write ran on the connection after the graph was drawn. */
export const DATA_CHANGED_TEXT = 'A statement that can change data ran on this connection after this graph was drawn, so the ids drawn here may now belong to other elements. Expand, Connect and Find path are off until you run the query again; the drawing and the Table still show the answer as it was.';

/** Said when an action is asked of an element already known to be out of date. */
export const STALE_ELEMENT_TEXT = 'This element is out of date: the database now holds a different element under its id. Dismiss it, or run the query again.';

/** Said for a relationship known to be out of date (relationships are not dismissed on their own). */
export const STALE_RELATIONSHIP_TEXT = 'This relationship is out of date: the database now holds a different relationship under its id. Dismiss a node at either end of it, or run the query again.';

/** Said when Connect is asked while some drawn relationships (and no nodes) are out of date. */
export const STALE_CONNECT_RELATIONSHIPS_TEXT = 'Some drawn relationships are out of date (shown dashed), so connecting the nodes could draw relationships of other elements. Dismiss a node at either end of them, or run the query again.';

/** Said when Connect is asked while some drawn nodes are out of date. */
export const STALE_CONNECT_TEXT = 'Some drawn nodes are out of date, so connecting them could draw relationships of other elements. Dismiss the out-of-date nodes (shown dashed), or run the query again.';
