// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TEST SUPPORT - GRAPH BUILDERS AND A SEEDED GENERATOR (pure: also used by the browser harness)
// =============================================================================
//
// Small builders for wire-shaped nodes and relationships, and a deterministic
// graph generator (mulberry32 seed) used by the model, geometry and layout
// tests and by the browser/performance scenarios (100, 300 and 1,000 nodes with
// up to 2,000 relationships, parallel and self edges included).
// =============================================================================

import { collectEntities } from '../../src/graph/results';
import type { IEntities } from '../../src/graph/results';
import type { GraphNode, GraphRelationship, GraphValue } from '../../src/graph/types';

/** Build a wire-shaped node. */
export function node(id: string, labels: string[] = ['Person'], properties: Record<string, GraphValue> = {}): GraphNode {
	return { '@kind': 'node', id, labels, properties };
}

/** Build a wire-shaped relationship. */
export function rel(id: string, type: string, start: string, end: string, properties: Record<string, GraphValue> = {}): GraphRelationship {
	return { '@kind': 'relationship', id, type, start, end, properties };
}

/** Entities of a hand-built graph. */
export function entitiesOf(nodes: GraphNode[], relationships: GraphRelationship[]): IEntities {
	return collectEntities([[...nodes, ...relationships]]);
}

/** Deep-freeze a value so any accidental mutation throws in strict mode. */
export function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Options for {@link generateGraph}. */
export interface IGenerateOptions {
	nodes: number;
	relationships: number;
	seed: number;
	labels?: string[];
	/** Fraction of relationships that duplicate an existing pair (parallel edges). */
	parallel?: number;
	/** Fraction of relationships that are self loops. */
	selfLoops?: number;
}

/**
 * A reproducible random graph. Ids are strings (some beyond 2^53, as on AGE) and
 * relationship endpoints are listed in STORED direction.
 */
export function generateGraph(options: IGenerateOptions): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
	const random = prng(options.seed);
	const labels = options.labels ?? ['Person', 'Company', 'City', 'Product', 'Tag', 'Event', 'Place', 'Doc'];
	const base = 11821949021847553n;
	const nodes: GraphNode[] = [];
	for (let i = 0; i < options.nodes; i++) {
		nodes.push(node(String(base + BigInt(i)), [labels[Math.floor(random() * labels.length)]], { name: `n${i}`, i }));
	}
	const relationships: GraphRelationship[] = [];
	for (let i = 0; i < options.relationships; i++) {
		let from = Math.floor(random() * options.nodes);
		let to = Math.floor(random() * options.nodes);
		const roll = random();
		if (roll < (options.selfLoops ?? 0)) to = from;
		else if (roll < (options.selfLoops ?? 0) + (options.parallel ?? 0) && relationships.length > 0) {
			const previous = relationships[Math.floor(random() * relationships.length)];
			from = nodes.findIndex((n) => n.id === previous.start);
			to = nodes.findIndex((n) => n.id === previous.end);
		}
		relationships.push(rel(String(900000000000000001n + BigInt(i)), `R${i % 5}`, nodes[from].id, nodes[to].id));
	}
	return { nodes, relationships };
}
