// MIT License
//
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
// CATALOG: the node catalog the static pipeline rules read, built from the branch
// =============================================================================

/**
 * The static checks and the fake engine read one catalog: every node's
 * provider name (its `protocol`), class types, lanes, profiles and invoke
 * rules, straight from `nodes/src/nodes/<dir>/services*.json` in this
 * checkout. Building it at run time keeps the checks on the branch's own
 * nodes; nothing is copied.
 */

/// <reference types="node" />

import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// PATHS
// =============================================================================

/** This folder: apps/shared/src/modules/agent/eval. */
export const EVAL_DIR = __dirname;

/** The checkout's root, six folders up. */
export const REPO_ROOT = path.resolve(EVAL_DIR, '../../../../../..');

/** The scenario data: scenarios, fixtures, references, inputs and recordings. EVAL_DATA_DIR points elsewhere (replay.test.ts uses it). */
export const DATA_DIR = process.env.EVAL_DATA_DIR ?? path.join(EVAL_DIR, 'data');

/** The node folders the catalog is read from. */
const NODES_DIR = path.join(REPO_ROOT, 'nodes/src/nodes');

// =============================================================================
// TYPES
// =============================================================================

/** An invoke rule: how many of a class an invoker takes. */
export interface InvokeRule {
	description?: string;
	min?: number;
	max?: number;
}

/** One node, as the static rules read it. */
export interface CatalogEntry {
	/** The node's folder under nodes/src/nodes. */
	dir: string;
	/** Its display title. */
	title: string;
	/** Its class types, such as source or llm. */
	classType: string[];
	/** Input lane to output lanes; `_source` holds a source's outputs. */
	lanes: Record<string, string[]>;
	/** Its profile names. */
	profiles: string[];
	/** The default profile. */
	default: string | null;
	/** The classes it invokes over the control plane, with their limits. */
	invoke: Record<string, InvokeRule> | null;
	/** Its capability tags. */
	capabilities: string[];
	/** The whole services file, for getService. */
	raw: Record<string, unknown>;
}

// =============================================================================
// JSONC
// =============================================================================

/**
 * Strips `//` and `/* *\/` comments outside strings, and trailing commas, so
 * JSON.parse reads a services file. The same rules as the scenario tools'
 * jsonc.py.
 *
 * @param text - The file text.
 * @returns Plain JSON text.
 */
export function stripJsonc(text: string): string {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			out += c;
			if (c === '\\') {
				out += text[i + 1] ?? '';
				i++;
			} else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
		} else if (text.startsWith('//', i)) {
			const end = text.indexOf('\n', i);
			i = end < 0 ? text.length : end - 1;
		} else if (text.startsWith('/*', i)) {
			const end = text.indexOf('*/', i);
			i = end < 0 ? text.length : end + 1;
		} else out += c;
	}
	return out.replace(/,(\s*[}\]])/g, '$1');
}

// =============================================================================
// THE CATALOG
// =============================================================================

let cached: Map<string, CatalogEntry> | null = null;

/**
 * The catalog, read once per process. A file without a protocol is skipped.
 *
 * @returns Every node by provider name.
 */
export function catalog(): Map<string, CatalogEntry> {
	if (cached) return cached;
	const out = new Map<string, CatalogEntry>();
	for (const dir of fs.readdirSync(NODES_DIR).sort()) {
		const folder = path.join(NODES_DIR, dir);
		if (!fs.statSync(folder).isDirectory()) continue;
		for (const file of fs.readdirSync(folder).sort()) {
			if (!/^services.*\.json$/.test(file)) continue;
			const raw = JSON.parse(stripJsonc(fs.readFileSync(path.join(folder, file), 'utf8'))) as Record<string, unknown>;
			const name = String(raw.protocol ?? '').split(':')[0];
			if (!name) continue;
			const preconfig = (raw.preconfig ?? {}) as { profiles?: Record<string, unknown>; default?: string };
			out.set(name, {
				dir,
				title: String(raw.title ?? name),
				classType: Array.isArray(raw.classType) ? (raw.classType as string[]) : [],
				lanes: (raw.lanes ?? {}) as Record<string, string[]>,
				profiles: Object.keys(preconfig.profiles ?? {}),
				default: preconfig.default ?? null,
				invoke: (raw.invoke ?? null) as Record<string, InvokeRule> | null,
				capabilities: Array.isArray(raw.capabilities) ? (raw.capabilities as string[]) : [],
				raw,
			});
		}
	}
	cached = out;
	return out;
}
