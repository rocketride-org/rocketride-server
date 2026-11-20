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
// GRAPH - VALUE GUARDS, KEY DECODING AND DISPLAY TEXT
// =============================================================================
//
// Everything here works on values AFTER `JSON.parse`. By then the node has
// already made them safe: integers beyond 2^53 and decimals arrive as `number`
// tags (text), never as JSON numbers, so re-serialising a parsed value cannot
// lose precision. A number that is an unsafe integer anyway means an old node
// (or a path that bypassed the serializer); {@link countUnsafeNumbers} finds it
// so the UI can say so instead of showing a rounded value as exact.
//
// Tags are trusted only in the exact shape the serializer writes. An object
// with a tag-looking key but the wrong shape is a malformed value, reported as
// such, never silently treated as a plain map and never as a graph entity.
// =============================================================================

import type { GraphBytes, GraphNode, GraphNumber, GraphPath, GraphPoint, GraphRelationship, GraphTemporal, GraphValue, TemporalType } from './types';

// =============================================================================
// SHAPE GUARDS
// =============================================================================

/** Traversal bound: no value is walked deeper than this (the node refuses deeper input). */
export const MAX_DEPTH = 64;

/** Traversal bound: no walk visits more values than this. */
export const MAX_VISITS = 1_000_000;

const TEMPORAL_TYPES: ReadonlySet<string> = new Set<TemporalType>(['date', 'time', 'localtime', 'datetime', 'localdatetime', 'duration']);

/**
 * Whether a value is a plain JSON object (not null, not an array).
 *
 * @param value - Any value.
 * @returns True for a non-null, non-array object.
 */
export function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether every element of an array satisfies a guard.
 *
 * @param value - Any value.
 * @param guard - The element guard.
 * @returns True for an array whose elements all pass.
 */
function arrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
	return Array.isArray(value) && value.every(guard);
}

/**
 * Whether a value is a graph node in the serializer's shape.
 *
 * @param value - Any value.
 * @returns True for a well-formed node.
 */
export function isGraphNode(value: unknown): value is GraphNode {
	return isPlainObject(value) && value['@kind'] === 'node' && typeof value.id === 'string' && arrayOf(value.labels, (l): l is string => typeof l === 'string') && isPlainObject(value.properties);
}

/**
 * Whether a value is a graph relationship in the serializer's shape.
 *
 * @param value - Any value.
 * @returns True for a well-formed relationship.
 */
export function isGraphRelationship(value: unknown): value is GraphRelationship {
	return isPlainObject(value) && value['@kind'] === 'relationship' && typeof value.id === 'string' && typeof value.type === 'string' && typeof value.start === 'string' && typeof value.end === 'string' && isPlainObject(value.properties);
}

/**
 * Whether a value is a graph path in the serializer's shape.
 *
 * @param value - Any value.
 * @returns True for a well-formed path (`relationships.length === nodes.length - 1`).
 */
export function isGraphPath(value: unknown): value is GraphPath {
	if (!isPlainObject(value) || value['@kind'] !== 'path') return false;
	if (!arrayOf(value.nodes, isGraphNode) || !arrayOf(value.relationships, isGraphRelationship)) return false;
	return value.nodes.length === 0 ? value.relationships.length === 0 : value.relationships.length === value.nodes.length - 1;
}

/**
 * Whether a value is a temporal tag.
 *
 * @param value - Any value.
 * @returns True for a well-formed temporal value.
 */
export function isGraphTemporal(value: unknown): value is GraphTemporal {
	return isPlainObject(value) && value['@kind'] === 'temporal' && typeof value.type === 'string' && TEMPORAL_TYPES.has(value.type) && typeof value.value === 'string' && (value.zone === undefined || typeof value.zone === 'string');
}

/**
 * Whether a value is a point tag.
 *
 * @param value - Any value.
 * @returns True for a well-formed point.
 */
export function isGraphPoint(value: unknown): value is GraphPoint {
	return isPlainObject(value) && value['@kind'] === 'point' && typeof value.srid === 'number' && arrayOf(value.coordinates, (c): c is number => typeof c === 'number');
}

/**
 * Whether a value is a number tag (text standing in for a number JSON cannot carry exactly).
 *
 * @param value - Any value.
 * @returns True for a well-formed number tag.
 */
export function isGraphNumber(value: unknown): value is GraphNumber {
	return isPlainObject(value) && value['@kind'] === 'number' && typeof value.value === 'string';
}

/**
 * Whether a value is a binary tag.
 *
 * @param value - Any value.
 * @returns True for a well-formed bytes value (`base64` is a string or null).
 */
export function isGraphBytes(value: unknown): value is GraphBytes {
	return isPlainObject(value) && value['@kind'] === 'bytes' && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0 && (value.base64 === null || typeof value.base64 === 'string');
}

/**
 * Whether an object carries a `@kind` key at all (so it is a tag, well-formed or not).
 *
 * @param value - Any value.
 * @returns True when the object has a `@kind` key.
 */
export function hasKindKey(value: unknown): boolean {
	return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, '@kind');
}

/**
 * Whether a value is a tagged graph value in a recognised, well-formed shape.
 *
 * @param value - Any value.
 * @returns True for a node, relationship, path, temporal, point, number or bytes tag.
 */
export function isTagged(value: unknown): value is GraphNode | GraphRelationship | GraphPath | GraphTemporal | GraphPoint | GraphNumber | GraphBytes {
	return isGraphNode(value) || isGraphRelationship(value) || isGraphPath(value) || isGraphTemporal(value) || isGraphPoint(value) || isGraphNumber(value) || isGraphBytes(value);
}

// =============================================================================
// KEYS
// =============================================================================

/**
 * Decode a key of a user map as it arrives: exactly ONE leading `@` is removed
 * (the serializer added it). Keys without a leading `@` are untouched.
 *
 * @param key - A key from a property map or a user map on the wire.
 * @returns The key as the user wrote it.
 */
export function decodeUserKey(key: string): string {
	return key.charCodeAt(0) === 0x40 ? key.slice(1) : key;
}

/**
 * Encode a user map key for the wire (the inverse of {@link decodeUserKey}).
 *
 * @param key - A key as the user wrote it.
 * @returns The key with exactly one extra leading `@` when it starts with one.
 */
export function encodeUserKey(key: string): string {
	return key.charCodeAt(0) === 0x40 ? `@${key}` : key;
}

/**
 * The entries of a user map (a property map, or a map cell) with decoded keys,
 * in the wire's key order. Duplicate decoded keys cannot occur: decoding is
 * injective on keys the serializer produced.
 *
 * @param map - A property map or a map value.
 * @returns `[key, value]` pairs.
 */
export function userEntries(map: { [key: string]: GraphValue }): Array<[string, GraphValue]> {
	return Object.keys(map).map((key) => [decodeUserKey(key), map[key]]);
}

// =============================================================================
// PRECISION
// =============================================================================

/**
 * Count the JSON numbers in a value that are integers beyond the safe range.
 * Such a number was rounded by `JSON.parse` before any app code ran, so it must
 * not be presented as exact.
 *
 * @param value - Any parsed value.
 * @returns The number of unsafe integers found (bounded walk).
 */
export function countUnsafeNumbers(value: unknown): number {
	let count = 0;
	let visits = 0;
	const stack: Array<[unknown, number]> = [[value, 0]];
	while (stack.length > 0 && visits < MAX_VISITS) {
		const [current, depth] = stack.pop() as [unknown, number];
		visits += 1;
		if (typeof current === 'number') {
			if (Number.isInteger(current) && !Number.isSafeInteger(current)) count += 1;
		} else if (depth < MAX_DEPTH && Array.isArray(current)) {
			for (const item of current) stack.push([item, depth + 1]);
		} else if (depth < MAX_DEPTH && isPlainObject(current)) {
			for (const key of Object.keys(current)) stack.push([current[key], depth + 1]);
		}
	}
	return count;
}

/**
 * Pretty JSON text for Raw views and Copy-as-JSON. Because tagged values already
 * carry exact text for anything beyond a safe number, `JSON.stringify` is
 * precision-safe here; the function exists so every copy path goes through one
 * place and so a regression in that property is caught by a test.
 *
 * @param value - Any parsed value.
 * @param indent - Spaces per level (0 for one line).
 * @returns The JSON text.
 */
export function toJsonText(value: unknown, indent = 2): string {
	return JSON.stringify(value, null, indent) ?? 'null';
}

// =============================================================================
// DISPLAY TEXT
// =============================================================================

/** Cells longer than this are cut with an ellipsis in the table (the inspector shows everything). */
export const MAX_CELL_CHARS = 200;

/**
 * Cut text to a bounded length.
 *
 * @param text - Any text.
 * @param limit - Maximum length including the ellipsis.
 * @returns The text, or its start plus an ellipsis.
 */
export function clip(text: string, limit = MAX_CELL_CHARS): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * One-line text for a value, for table cells and announcements.
 *
 * @param value - A cell value.
 * @param depth - Recursion guard (internal).
 * @returns Display text (never throws, bounded length).
 */
export function describeValue(value: unknown, depth = 0): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (depth > 4) return '…';
	if (Array.isArray(value)) return clip(`[${value.map((item) => describeValue(item, depth + 1)).join(', ')}]`);
	if (isGraphNode(value)) {
		const labels = value.labels.map((l) => `:${l}`).join('');
		return clip(`(${labels}${labels ? ' ' : ''}${describeProps(value.properties, depth)})`.replace(/\s+\)/, ')'));
	}
	if (isGraphRelationship(value)) return clip(`[:${value.type}${Object.keys(value.properties).length > 0 ? ' ' : ''}${describeProps(value.properties, depth)}]`.replace(/\s+\]/, ']'));
	if (isGraphPath(value)) return `path (${value.nodes.length} ${value.nodes.length === 1 ? 'node' : 'nodes'}, ${value.relationships.length} ${value.relationships.length === 1 ? 'relationship' : 'relationships'})`;
	if (isGraphTemporal(value)) return value.zone ? `${value.value} [${value.zone}]` : value.value;
	if (isGraphPoint(value)) return `point(srid ${value.srid}: ${value.coordinates.join(', ')})`;
	if (isGraphNumber(value)) return value.value;
	if (isGraphBytes(value)) return `binary, ${value.size.toLocaleString('en-US')} ${value.size === 1 ? 'byte' : 'bytes'}`;
	if (isPlainObject(value)) return clip(`{${describeProps(value as { [key: string]: GraphValue }, depth)}}`);
	return String(value);
}

/**
 * `key: value, ...` text for a property map (decoded keys).
 *
 * @param map - A property or user map.
 * @param depth - Recursion guard (internal).
 * @returns The inner text of a Cypher map literal.
 */
function describeProps(map: { [key: string]: GraphValue }, depth: number): string {
	return userEntries(map)
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : describeValue(value, depth + 1)}`)
		.join(', ');
}

/**
 * Full (unclipped) text for a value, for the inspector: strings as they are,
 * scalars and tags by their text, containers as compact JSON (precision-safe,
 * because tagged numbers are text already).
 *
 * @param value - A property or cell value.
 * @returns Text.
 */
export function valueText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (isGraphNumber(value) || isGraphTemporal(value) || isGraphPoint(value) || isGraphBytes(value)) return describeValue(value);
	return toJsonText(value, 0);
}

/**
 * A copy of a value with the keys of every user map in it decoded (one leading `@` removed, at every depth). Tagged
 * values, well-formed or not, keep their wire shape: a `@kind` key on the wire always means a tag, because a user key
 * `@kind` arrives as `@@kind`.
 *
 * @param value - A parsed value.
 * @param depth - Recursion guard (internal).
 * @returns The decoded copy (null-prototype maps, so any key is kept as data).
 */
function decodeKeys(value: unknown, depth: number): unknown {
	if (depth >= MAX_DEPTH) return value;
	if (Array.isArray(value)) return value.map((item) => decodeKeys(item, depth + 1));
	if (!isPlainObject(value) || hasKindKey(value)) return value;
	const out: { [key: string]: unknown } = Object.create(null);
	for (const key of Object.keys(value)) out[decodeUserKey(key)] = decodeKeys(value[key], depth + 1);
	return out;
}

/**
 * Full text for a value as the user wrote it, for the node inspector: as {@link valueText}, except that a list or
 * map shows the keys of its user maps decoded, as the Table does. Copy JSON and the row inspector keep the wire form.
 *
 * @param value - A property value.
 * @returns Text.
 */
export function decodedText(value: unknown): string {
	if (Array.isArray(value) || (isPlainObject(value) && !hasKindKey(value))) return toJsonText(decodeKeys(value, 0), 0);
	return valueText(value);
}

/**
 * Whether a cell value is a graph entity (node, relationship or path).
 *
 * @param value - A cell value.
 * @returns True for a node, relationship or path.
 */
export function isGraphEntity(value: unknown): value is GraphNode | GraphRelationship | GraphPath {
	return isGraphNode(value) || isGraphRelationship(value) || isGraphPath(value);
}
