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
// GRAPH - WIRE TYPES (contract v1, section 1.2)
// =============================================================================
//
// The shapes the node's `read_query` (and `execute` with shape 'graph') put on
// the wire. Only the node's serializer creates the `@kind` tags; a key of a USER
// map that starts with `@` arrives with exactly one extra leading `@`, so a tag
// in the data can never be a user's key. Ids and relationship endpoints are
// opaque strings: they are never parsed as numbers and never compared by value
// across connections or transactions (they are live handles, not durable keys).
// =============================================================================

/** An opaque element id (Neo4j elementId, or an exact decimal for AGE/FalkorDB). */
export type GraphId = string;

/** A node as the node's serializer writes it. */
export interface GraphNode {
	'@kind': 'node';
	id: GraphId;
	/** Sorted by the node. Always one label on AGE. */
	labels: string[];
	properties: { [key: string]: GraphValue };
}

/** A relationship as the node's serializer writes it. */
export interface GraphRelationship {
	'@kind': 'relationship';
	id: GraphId;
	type: string;
	/** Start node id, direction AS STORED (even for a path walked backwards). */
	start: GraphId;
	/** End node id, direction as stored. */
	end: GraphId;
	properties: { [key: string]: GraphValue };
}

/** A path: `relationships[i]` joins `nodes[i]` and `nodes[i + 1]`, in traversal order. */
export interface GraphPath {
	'@kind': 'path';
	nodes: GraphNode[];
	relationships: GraphRelationship[];
}

/** The temporal families the node tags (with an ISO-8601 `value`). */
export type TemporalType = 'date' | 'time' | 'localtime' | 'datetime' | 'localdatetime' | 'duration';

/** A temporal value. `zone` is a named zone when the engine has one. */
export interface GraphTemporal {
	'@kind': 'temporal';
	type: TemporalType;
	value: string;
	zone?: string;
}

/** A point (Neo4j). FalkorDB points arrive as plain maps, with no tag. */
export interface GraphPoint {
	'@kind': 'point';
	srid: number;
	coordinates: number[];
}

/** An integer beyond 2^53, a decimal, NaN or an infinity, as text (never rounded). */
export interface GraphNumber {
	'@kind': 'number';
	value: string;
}

/** Binary data (contract v1.1): its size, and its bytes as base64 unless it exceeds 64 KiB (then `base64` is null). */
export interface GraphBytes {
	'@kind': 'bytes';
	size: number;
	base64: string | null;
}

/** Any value that can sit in a result cell. */
export type GraphValue = null | boolean | number | string | GraphValue[] | { [key: string]: GraphValue } | GraphNode | GraphRelationship | GraphPath | GraphTemporal | GraphPoint | GraphNumber | GraphBytes;

/** The `read_query` envelope (contract v1 section 1.1). Rows are positional arrays. */
export interface ReadQueryResult {
	columns: string[];
	rows: GraphValue[][];
	/** The row limit the node applied (it clamps what was asked). */
	row_limit: number;
	truncated: boolean;
	/** Which budget cut the result, when one did. */
	truncated_by: null | 'rows' | 'elements' | 'values';
	element_limit: number;
	elements: number;
	value_limit: number;
	values: number;
	/** `execute` with shape 'graph' only, when the driver knows it. */
	affected_rows?: number;
}
