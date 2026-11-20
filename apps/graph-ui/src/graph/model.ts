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
// GRAPH - CANVAS MODEL (what is drawn, and the budgets that bound it)
// =============================================================================
//
// A pure, immutable model of the graph view: which nodes and relationships the
// canvas holds, which of them came from the query result and which from
// expansions, and what each budget cut. No React, no layout, no network; every
// operation returns a new model, so the component can compare by reference and
// the tests can drive it like a state machine.
//
// Budgets (see budgets.ts): 300 nodes at first, 1,000 nodes and 2,000
// relationships at most, 100 NEW neighbours per expansion. Ids are opaque
// strings and live handles, so the model is keyed by id and thrown away whenever
// the connection (or its generation) changes; it never persists an id.
//
// The wire objects are stored as they arrived and never mutated, so a layout
// engine that mutates its own copies (d3 does) cannot corrupt them.
// =============================================================================

import { INITIAL_NODES, MAX_NEW_NEIGHBORS, MAX_NODES, MAX_RELATIONSHIPS } from './budgets';
import type { IEntities } from './results';
import type { GraphId, GraphNode, GraphPath, GraphRelationship } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** The canvas model. Treat it as immutable. */
export interface IGraphModel {
	/** Drawn nodes, in the order they were first shown. */
	readonly nodes: ReadonlyMap<GraphId, GraphNode>;
	/** Drawn relationships, in the order they were first shown. */
	readonly relationships: ReadonlyMap<GraphId, GraphRelationship>;
	/** Ids of the nodes that came from the query result itself. */
	readonly roots: ReadonlySet<GraphId>;
	/** For each expanded node, the ids that expansion added. */
	readonly expansions: ReadonlyMap<GraphId, ReadonlySet<GraphId>>;
	/** Distinct nodes in the result this model was built from. */
	readonly resultNodes: number;
	/** Distinct relationships in the result this model was built from. */
	readonly resultRelationships: number;
	/** Result nodes not drawn because of a budget. */
	readonly hiddenNodes: number;
	/** Result relationships not drawn because of a budget or a missing endpoint. */
	readonly hiddenRelationships: number;
}

/** Which budget stopped an operation. */
export type BudgetHit = null | 'nodes' | 'relationships';

/** What an expansion did. */
export interface IExpandOutcome {
	model: IGraphModel;
	/** Neighbours newly drawn. */
	addedNodes: GraphId[];
	/** Relationships newly drawn. */
	addedRelationships: GraphId[];
	/** New neighbours the 100-per-expansion cap (or the node budget) left out. */
	skippedNeighbors: number;
	/** The canvas budget that stopped the expansion, if any. */
	budget: BudgetHit;
	/** Neighbours that were already drawn (not counted against the cap). */
	alreadyShown: number;
}

// =============================================================================
// CONSTRUCTION
// =============================================================================

/** An empty model. */
export const EMPTY_MODEL: IGraphModel = {
	nodes: new Map(),
	relationships: new Map(),
	roots: new Set(),
	expansions: new Map(),
	resultNodes: 0,
	resultRelationships: 0,
	hiddenNodes: 0,
	hiddenRelationships: 0,
};

/**
 * Build the model for a fresh result: the first `limit` distinct nodes (never
 * more than the canvas maximum), and every relationship whose two ends are
 * drawn, up to the relationship budget.
 *
 * @param entities - The result's distinct entities.
 * @param limit - Nodes to draw (default: the initial 300).
 * @returns The model.
 */
export function modelFromResult(entities: IEntities, limit: number = INITIAL_NODES): IGraphModel {
	const cap = Math.max(0, Math.min(limit, MAX_NODES));
	const nodes = new Map<GraphId, GraphNode>();
	for (const [id, node] of entities.nodes) {
		if (nodes.size >= cap) break;
		nodes.set(id, node);
	}
	const relationships = new Map<GraphId, GraphRelationship>();
	for (const [id, rel] of entities.relationships) {
		if (relationships.size >= MAX_RELATIONSHIPS) break;
		if (nodes.has(rel.start) && nodes.has(rel.end)) relationships.set(id, rel);
	}
	return {
		nodes,
		relationships,
		roots: new Set(nodes.keys()),
		expansions: new Map(),
		resultNodes: entities.nodes.size,
		resultRelationships: entities.relationships.size,
		hiddenNodes: entities.nodes.size - nodes.size,
		hiddenRelationships: entities.relationships.size - relationships.size,
	};
}

/**
 * Draw more of the same result, up to a larger node limit, keeping every
 * expansion the user already made.
 *
 * @param model - The current model.
 * @param entities - The result's distinct entities (the same result the model was built from).
 * @param limit - The new node limit (capped at the canvas maximum).
 * @returns The model with more of the result drawn.
 */
export function revealMore(model: IGraphModel, entities: IEntities, limit: number = MAX_NODES): IGraphModel {
	const cap = Math.min(limit, MAX_NODES);
	const nodes = new Map(model.nodes);
	const roots = new Set(model.roots);
	for (const [id, node] of entities.nodes) {
		if (nodes.size >= cap) break;
		if (!nodes.has(id)) {
			nodes.set(id, node);
			roots.add(id);
		}
	}
	const relationships = new Map(model.relationships);
	for (const [id, rel] of entities.relationships) {
		if (relationships.size >= MAX_RELATIONSHIPS) break;
		if (!relationships.has(id) && nodes.has(rel.start) && nodes.has(rel.end)) relationships.set(id, rel);
	}
	return {
		...model,
		nodes,
		relationships,
		roots,
		hiddenNodes: Math.max(0, entities.nodes.size - roots.size),
		hiddenRelationships: Math.max(0, entities.relationships.size - countResultRelationships(relationships, entities)),
	};
}

/**
 * Count the drawn relationships that belong to a result.
 *
 * @param drawn - The drawn relationships.
 * @param entities - The result's entities.
 * @returns How many drawn relationships are in the result.
 */
function countResultRelationships(drawn: ReadonlyMap<GraphId, GraphRelationship>, entities: IEntities): number {
	let count = 0;
	for (const id of drawn.keys()) if (entities.relationships.has(id)) count += 1;
	return count;
}

// =============================================================================
// EXPANSION
// =============================================================================

/**
 * Add a node's neighbours from an expansion answer.
 *
 * At most `maxNew` neighbours that are NOT already drawn are added, in the order
 * the answer lists them (neighbours already drawn do not count against the cap),
 * and the canvas budgets still apply. A relationship is drawn when both of its
 * ends are drawn afterwards, so an expansion also draws the relationships a new
 * neighbour has to other nodes that happen to be in the answer. Entities with
 * the same id replace the drawn copy (the answer is the fresher read).
 *
 * @param model - The current model.
 * @param centerId - The node that was expanded.
 * @param entities - The distinct entities of the expansion answer.
 * @param maxNew - New neighbours allowed (default 100).
 * @returns The new model and what was added or left out.
 */
export function expandNode(model: IGraphModel, centerId: GraphId, entities: IEntities, maxNew: number = MAX_NEW_NEIGHBORS): IExpandOutcome {
	const nodes = new Map(model.nodes);
	const relationships = new Map(model.relationships);
	const added = new Set<GraphId>();
	let skipped = 0;
	let alreadyShown = 0;
	let budget: BudgetHit = null;

	// The center's own fresh copy, when the answer carries it.
	const center = entities.nodes.get(centerId);
	if (center && nodes.has(centerId)) nodes.set(centerId, center);

	// Neighbours, in the order the answer lists the relationships.
	const seenNeighbors = new Set<GraphId>();
	for (const rel of entities.relationships.values()) {
		const other = rel.start === centerId ? rel.end : rel.end === centerId ? rel.start : null;
		if (other === null || other === centerId || seenNeighbors.has(other)) continue;
		seenNeighbors.add(other);
		const node = entities.nodes.get(other);
		if (!node) continue;
		if (nodes.has(other)) {
			alreadyShown += 1;
			nodes.set(other, node);
			continue;
		}
		if (added.size >= maxNew) {
			skipped += 1;
			continue;
		}
		if (nodes.size >= MAX_NODES) {
			skipped += 1;
			budget = 'nodes';
			continue;
		}
		nodes.set(other, node);
		added.add(other);
	}

	const addedRelationships: GraphId[] = [];
	for (const [id, rel] of entities.relationships) {
		if (!nodes.has(rel.start) || !nodes.has(rel.end)) continue;
		if (relationships.has(id)) {
			relationships.set(id, rel);
			continue;
		}
		if (relationships.size >= MAX_RELATIONSHIPS) {
			budget = budget ?? 'relationships';
			continue;
		}
		relationships.set(id, rel);
		addedRelationships.push(id);
	}

	const expansions = new Map(model.expansions);
	const previous = expansions.get(centerId);
	expansions.set(centerId, previous ? new Set([...previous, ...added]) : added);

	return {
		model: { ...model, nodes, relationships, expansions },
		addedNodes: [...added],
		addedRelationships,
		skippedNeighbors: skipped,
		budget,
		alreadyShown,
	};
}

/**
 * Draw the relationships among nodes that are already drawn (the "connect
 * result nodes" action). Entities whose ends are not both drawn are ignored.
 *
 * @param model - The current model.
 * @param entities - The distinct entities of the answer.
 * @returns The model, the relationships added, and the budget hit if any.
 */
export function connectNodes(model: IGraphModel, entities: IEntities): { model: IGraphModel; addedRelationships: GraphId[]; budget: BudgetHit } {
	const relationships = new Map(model.relationships);
	const added: GraphId[] = [];
	let budget: BudgetHit = null;
	for (const [id, rel] of entities.relationships) {
		if (relationships.has(id) || !model.nodes.has(rel.start) || !model.nodes.has(rel.end)) continue;
		if (relationships.size >= MAX_RELATIONSHIPS) {
			budget = 'relationships';
			break;
		}
		relationships.set(id, rel);
		added.push(id);
	}
	return { model: { ...model, relationships }, addedRelationships: added, budget };
}

/**
 * Draw a found path: its nodes and relationships join the canvas (deduplicated,
 * within the budgets), in the path's own order. Nodes the path adds are NOT roots:
 * they came from a search, not from the result, so collapsing and dismissing treat
 * them like any other addition.
 *
 * @param model - The current model.
 * @param path - The path as the node serialised it (stored directions kept).
 * @returns The model, the ids newly drawn, and the budget hit if any.
 */
export function mergePath(model: IGraphModel, path: GraphPath): { model: IGraphModel; addedNodes: GraphId[]; addedRelationships: GraphId[]; budget: BudgetHit } {
	const nodes = new Map(model.nodes);
	const relationships = new Map(model.relationships);
	const addedNodes: GraphId[] = [];
	const addedRelationships: GraphId[] = [];
	let budget: BudgetHit = null;
	for (const node of path.nodes) {
		if (nodes.has(node.id)) continue;
		if (nodes.size >= MAX_NODES) {
			budget = 'nodes';
			continue;
		}
		nodes.set(node.id, node);
		addedNodes.push(node.id);
	}
	for (const rel of path.relationships) {
		if (relationships.has(rel.id) || !nodes.has(rel.start) || !nodes.has(rel.end)) continue;
		if (relationships.size >= MAX_RELATIONSHIPS) {
			budget = budget ?? 'relationships';
			continue;
		}
		relationships.set(rel.id, rel);
		addedRelationships.push(rel.id);
	}
	return { model: { ...model, nodes, relationships }, addedNodes, addedRelationships, budget };
}

// =============================================================================
// REMOVAL
// =============================================================================

/**
 * Remove nodes (and every relationship touching them) from the canvas.
 *
 * @param model - The current model.
 * @param ids - Nodes to dismiss.
 * @returns The model without them.
 */
export function dismissNodes(model: IGraphModel, ids: Iterable<GraphId>): IGraphModel {
	const gone = new Set(ids);
	if (gone.size === 0) return model;
	const nodes = new Map<GraphId, GraphNode>();
	for (const [id, node] of model.nodes) if (!gone.has(id)) nodes.set(id, node);
	const relationships = new Map<GraphId, GraphRelationship>();
	for (const [id, rel] of model.relationships) if (!gone.has(rel.start) && !gone.has(rel.end)) relationships.set(id, rel);
	const roots = new Set<GraphId>();
	for (const id of model.roots) if (!gone.has(id)) roots.add(id);
	const expansions = new Map<GraphId, ReadonlySet<GraphId>>();
	for (const [center, addedIds] of model.expansions) {
		if (gone.has(center)) continue;
		expansions.set(center, new Set([...addedIds].filter((id) => !gone.has(id))));
	}
	return { ...model, nodes, relationships, roots, expansions };
}

/**
 * Collapse an expanded node: remove the neighbours its expansion added that are
 * not held in place by anything else.
 *
 * A neighbour stays when it is part of the original result, was added by a
 * different expansion, or is still connected - without passing through the
 * collapsed node - to a node that stays. Whatever hangs only from the collapsed
 * node goes, together with its relationships.
 *
 * @param model - The current model.
 * @param centerId - The node to collapse.
 * @returns The model and the ids removed (empty when the node was never expanded).
 */
export function collapseNode(model: IGraphModel, centerId: GraphId): { model: IGraphModel; removed: GraphId[] } {
	const added = model.expansions.get(centerId);
	if (!added || added.size === 0) {
		if (!model.expansions.has(centerId)) return { model, removed: [] };
		const expansions = new Map(model.expansions);
		expansions.delete(centerId);
		return { model: { ...model, expansions }, removed: [] };
	}

	// What the collapse is answerable for: the nodes this expansion added, and -
	// transitively - whatever those nodes' own expansions added (a chain that
	// hangs from the collapsed node goes with it).
	const candidates = new Set<GraphId>();
	const pending = [centerId];
	const visited = new Set<GraphId>();
	while (pending.length > 0) {
		const center = pending.pop() as GraphId;
		if (visited.has(center)) continue;
		visited.add(center);
		for (const id of model.expansions.get(center) ?? []) {
			if (!model.nodes.has(id) || model.roots.has(id)) continue;
			candidates.add(id);
			pending.push(id);
		}
	}

	// Anything a LIVE expansion (one whose center is staying) added is held by it.
	for (const [other, ids] of model.expansions) {
		if (other === centerId || candidates.has(other)) continue;
		for (const id of ids) candidates.delete(id);
	}

	// Seeds: every drawn node that is not a candidate and is not the collapsed node.
	const adjacency = new Map<GraphId, GraphId[]>();
	for (const rel of model.relationships.values()) {
		if (rel.start === centerId || rel.end === centerId) continue; // edges through the center hold nothing
		if (!adjacency.has(rel.start)) adjacency.set(rel.start, []);
		if (!adjacency.has(rel.end)) adjacency.set(rel.end, []);
		adjacency.get(rel.start)?.push(rel.end);
		adjacency.get(rel.end)?.push(rel.start);
	}
	const kept = new Set<GraphId>();
	const queue: GraphId[] = [];
	for (const id of model.nodes.keys()) {
		if (id !== centerId && !candidates.has(id)) {
			kept.add(id);
			queue.push(id);
		}
	}
	while (queue.length > 0) {
		const id = queue.pop() as GraphId;
		for (const next of adjacency.get(id) ?? []) {
			if (candidates.has(next) && !kept.has(next)) {
				kept.add(next);
				queue.push(next);
			}
		}
	}
	const removed = [...candidates].filter((id) => !kept.has(id));
	const next = dismissNodes(model, removed);
	const expansions = new Map(next.expansions);
	expansions.delete(centerId);
	return { model: { ...next, expansions }, removed };
}

// =============================================================================
// QUERIES OVER THE MODEL
// =============================================================================

/**
 * Drawn relationships touching a node.
 *
 * @param model - The model.
 * @param id - A node id.
 * @returns The relationships, in drawn order.
 */
export function relationshipsOf(model: IGraphModel, id: GraphId): GraphRelationship[] {
	const out: GraphRelationship[] = [];
	for (const rel of model.relationships.values()) if (rel.start === id || rel.end === id) out.push(rel);
	return out;
}

/**
 * Drawn neighbours of a node, nearest-listed first, each once, without the node itself.
 *
 * @param model - The model.
 * @param id - A node id.
 * @returns Neighbour ids in a deterministic order.
 */
export function neighborIds(model: IGraphModel, id: GraphId): GraphId[] {
	const seen = new Set<GraphId>();
	const out: GraphId[] = [];
	for (const rel of relationshipsOf(model, id)) {
		const other = rel.start === id ? rel.end : rel.start;
		if (other !== id && !seen.has(other) && model.nodes.has(other)) {
			seen.add(other);
			out.push(other);
		}
	}
	return out;
}

/**
 * Whether a node has been expanded (and not collapsed since).
 *
 * @param model - The model.
 * @param id - A node id.
 * @returns True when an expansion is recorded for it.
 */
export function isExpanded(model: IGraphModel, id: GraphId): boolean {
	return model.expansions.has(id);
}
