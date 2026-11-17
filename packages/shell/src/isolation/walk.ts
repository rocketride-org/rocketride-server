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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// WALK — the bounded, fail-closed walker every inbound value goes through
// =============================================================================
//
// Inbound values arrive by structured clone, which keeps what JSON would not:
// cycles, `Map`, `Date`, transferred ports, `undefined`. The walker accepts
// only plain objects, arrays, strings, finite numbers, booleans and `null`
// (an `__rrbin` member is a plain object), refuses `__proto__`,
// `constructor` and `prototype` keys, caps depth and node count, deletes
// `undefined`-valued keys (the SDK sends them), and returns a null-prototype
// copy. Anything else throws `WalkError`, which the gate reports as `schema`.
// =============================================================================

import { SIZES } from './rate';

/** Why a value was refused. */
export class WalkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WalkError';
	}
}

/** A value over the walker's string budget (reported as `too_large`, not `schema`). */
export class WalkTooLargeError extends WalkError {
	constructor(message: string) {
		super(message);
		this.name = 'WalkTooLargeError';
	}
}

/** Deepest nesting accepted (the top-level value is depth 0). */
export const WALK_MAX_DEPTH = 64;
/** Most values (of any kind) in one walked value. */
export const WALK_MAX_NODES = 100_000;
/** Most string characters (values and keys together) in one walked value: one 8 MiB base64 payload plus a full request. */
export const WALK_MAX_STRING_CHARS = SIZES.stringCeiling + SIZES.request;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Walk options. */
export interface IWalkOptions {
	/** Sees every string (values and keys); may throw to refuse the value. */
	onString?(s: string): void;
}

/**
 * Validates and copies one value.
 *
 * @param value - The value as it arrived.
 * @param options - Hooks.
 * @returns A null-prototype copy without `undefined`-valued keys.
 * @throws WalkError for anything outside the accepted shapes or budgets.
 */
export function walk(value: unknown, options: IWalkOptions = {}): unknown {
	let nodes = 0;
	let chars = 0;
	const ancestors = new Set<object>();
	const countChars = (s: string): void => {
		chars += s.length;
		if (chars > WALK_MAX_STRING_CHARS) throw new WalkTooLargeError('too many string characters');
	};

	const visit = (v: unknown, depth: number): unknown => {
		if (++nodes > WALK_MAX_NODES) throw new WalkError('too many nodes');
		if (depth > WALK_MAX_DEPTH) throw new WalkError('too deep');
		if (v === null || typeof v === 'boolean') return v;
		if (typeof v === 'string') {
			countChars(v);
			options.onString?.(v);
			return v;
		}
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) throw new WalkError('non-finite number');
			return v;
		}
		if (typeof v !== 'object') throw new WalkError(`unsupported ${typeof v}`);
		if (ancestors.has(v)) throw new WalkError('cycle');
		const proto = Object.getPrototypeOf(v);
		if (Object.getOwnPropertySymbols(v).length > 0) throw new WalkError('symbol keys');
		ancestors.add(v);
		try {
			if (Array.isArray(v)) {
				if (proto !== Array.prototype || Object.keys(v).length !== v.length) throw new WalkError('not a plain array');
				const out: unknown[] = [];
				for (let i = 0; i < v.length; i++) {
					const d = Object.getOwnPropertyDescriptor(v, i);
					if (!d || !('value' in d) || d.value === undefined) throw new WalkError('array hole or accessor');
					out.push(visit(d.value, depth + 1));
				}
				return out;
			}
			if (proto !== Object.prototype && proto !== null) throw new WalkError('not a plain object');
			const out: Record<string, unknown> = Object.create(null);
			for (const key of Object.keys(v)) {
				if (FORBIDDEN_KEYS.has(key)) throw new WalkError('forbidden key');
				const d = Object.getOwnPropertyDescriptor(v, key)!;
				if (!('value' in d)) throw new WalkError('accessor property');
				if (d.value === undefined) continue;
				countChars(key);
				options.onString?.(key);
				out[key] = visit(d.value, depth + 1);
			}
			return out;
		} finally {
			ancestors.delete(v);
		}
	};

	return visit(value, 0);
}

/** UTF-8 length of a string, without allocating its encoding. */
export function utf8Length(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

/**
 * Whether a value is exactly the bus's binary member (`connection/binaryWire.ts`):
 * own keys `__rrbin` (true) and `b64` (a string), nothing else.
 */
export function isWireBinary(v: unknown): v is { __rrbin: true; b64: string } {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	const keys = Object.keys(v);
	return keys.length === 2 && (v as Record<string, unknown>).__rrbin === true && typeof (v as Record<string, unknown>).b64 === 'string';
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded length of a base64 payload, or -1 when it is not base64. */
export function b64DecodedLength(b64: string): number {
	if (b64.length % 4 !== 0 || !B64.test(b64)) return -1;
	const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
	return (b64.length / 4) * 3 - pad;
}

/**
 * The byte measure of plan section 4.3: UTF-8 `JSON.stringify`. Byte arrays,
 * and the one binary member at `binarySlot` (a valid `__rrbin` in a
 * `bytes<=8MiB` position), count at their decoded size in `bin`; any other
 * binary-shaped object is ordinary JSON, base64 text included.
 *
 * @param value - A walked value (or an engine response).
 * @param binarySlot - The member allowed to count as binary, if any.
 * @returns The JSON and binary byte counts.
 */
export function measure(value: unknown, binarySlot?: unknown): { json: number; bin: number } {
	let bin = 0;
	const text = JSON.stringify(value, (_key, v: unknown) => {
		if (binarySlot !== undefined && v === binarySlot && isWireBinary(v) && b64DecodedLength(v.b64) >= 0) {
			bin += b64DecodedLength(v.b64);
			return null;
		}
		if (ArrayBuffer.isView(v)) {
			bin += v.byteLength;
			return null;
		}
		return v;
	});
	return { json: text === undefined ? 0 : utf8Length(text), bin };
}
