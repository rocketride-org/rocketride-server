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
// CYPHER - VETTED PROCEDURES
// =============================================================================
//
// The only procedures the app treats as reads. Everything else that follows a
// `CALL` is a write as far as the text check is concerned, because a procedure
// can do anything (`apoc.cypher.runWrite`, `db.createLabel`, ...).
//
// Names are compared as lists of name PARTS after the surrounding backticks are
// removed (a doubled backtick becomes one) and case is folded. Parts, not a
// joined string, on purpose: `` `db.labels` `` is ONE part containing a dot, not
// the procedure `db.labels`, and must not be waved through because it prints
// the same. There is no wildcard: a future `db.schema.*` procedure is not read
// until someone reviews it and adds it here.
//
// This list is a courtesy for the editor. The node enforces its own allow-list
// on `read_query`, which (with the database account, where the node lets you
// choose one) is the real boundary. The names are the Neo4j node's
// NEO4J_READ_PROCEDURES (packages/ai/src/ai/common/graph/cypher_safety.py), and
// tests/classify.test.ts fails when the two lists differ. The node joins the
// parts before it compares, so it also allows a name quoted as one part.
// =============================================================================

/** The reviewed read-only procedures, one entry per name, as lowercase parts. */
export const VETTED_PROCEDURES: ReadonlyArray<readonly string[]> = [
	['db', 'labels'],
	['db', 'relationshiptypes'],
	['db', 'propertykeys'],
	['db', 'schema', 'visualization'],
	['db', 'schema', 'nodetypeproperties'],
	['db', 'schema', 'reltypeproperties'],
];

/**
 * Normalise name parts for comparison (case-folded).
 *
 * @param parts - The unquoted parts of a procedure name.
 * @returns The folded parts.
 */
export function normalizeProcedure(parts: readonly string[]): string[] {
	return parts.map((part) => part.toLowerCase());
}

/**
 * Whether a procedure name is on the reviewed read-only list.
 *
 * @param parts - The unquoted parts of the name (not yet case-folded).
 * @returns True when the procedure is vetted.
 */
export function isVettedProcedure(parts: readonly string[]): boolean {
	const folded = normalizeProcedure(parts);
	return VETTED_PROCEDURES.some((entry) => entry.length === folded.length && entry.every((part, i) => part === folded[i]));
}
