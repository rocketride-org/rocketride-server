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
// CYPHER - IDENTIFIER QUOTING
// =============================================================================
//
// Labels and relationship types are identifiers, and no engine can bind an
// identifier as a query parameter. Generated queries (label preview, expand,
// connect, path) therefore have to put them in the query TEXT, so every such
// name goes through here and nowhere else. Property VALUES and ids are never
// handled here: they are always bound parameters.
//
// The names come from the node's schema (actual labels in the graph), not from
// the user, but a label may contain a backtick, a space or any character, so
// the rule is "quote exactly as the dialect defines it, or refuse":
//
//   - Neo4j: wrap in backticks, a literal backtick is doubled.
//   - FalkorDB: wrap in backticks. Its parser has no escape for a backtick
//     inside a quoted name (a doubled one fails with "Invalid input", FalkorDB
//     issue #154, checked against a live server), and the FalkorDB node lists
//     such labels without sampling them for that reason, so a name holding one
//     is refused.
//   - Apache AGE: the translator's grammar accepts escaped names, but AGE's own
//     handling of an escaped LABEL is not proven on a live server, so only a
//     plain `[A-Za-z_][A-Za-z0-9_]*` name is emitted; anything else is refused
//     rather than guessed.
//   - Every dialect refuses a name that is empty, over-long, or holds a control
//     character or a lone surrogate (nothing sane can be quoted around those).
//
// A refusal returns null and the caller says why in the UI; it never falls back
// to concatenating the raw name.
// =============================================================================

/** The Cypher dialects the app speaks (the node's `dialect` tool answers one of these). */
export type GraphDialect = 'age' | 'neo4j' | 'falkordb';

/** Longest name the app will put in a generated query. */
export const MAX_IDENTIFIER_LENGTH = 500;

/** A name AGE accepts without any quoting. */
const AGE_PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a name can be placed inside any quoting at all.
 *
 * @param name - A label or relationship type from the schema.
 * @returns True when the name is non-empty, bounded and free of control characters and lone surrogates.
 */
export function isQuotable(name: string): boolean {
	if (typeof name !== 'string' || name.length === 0 || name.length > MAX_IDENTIFIER_LENGTH) return false;
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return false;
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = name.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/**
 * Quote a label or relationship type for the dialect, or refuse.
 *
 * @param name - The name exactly as the schema reports it.
 * @param dialect - The engine dialect.
 * @returns The text to put in the query, or null when the name cannot be used safely.
 */
export function quoteIdentifier(name: string, dialect: GraphDialect): string | null {
	if (!isQuotable(name)) return null;
	if (dialect === 'age') return AGE_PLAIN.test(name) ? name : null;
	if (dialect === 'falkordb') return name.includes('`') ? null : `\`${name}\``;
	return `\`${name.split('`').join('``')}\``;
}
