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
// GRAPH - STARTER TEMPLATES (a few reads to start from, per connection)
// =============================================================================
//
// The Saved panel offers these under "Starter templates". Each one is a read the
// browse editor sends as it is (a unit test runs every template through the text
// check), and the ones that name a label or a relationship type take it from the
// connection's own schema: the first one with data that the engine can quote.
//
// Per engine, only what that engine runs:
//   - Apache AGE runs labels(), type() and count (probed on 1.5.0), but refuses
//     ORDER BY on a RETURN alias, which both counts use, and CALL and label
//     predicates; whether it runs a pattern predicate is not verified. So it
//     gets only the sample, a label and a pattern;
//   - "Nodes with no relationships" uses a pattern predicate (WHERE NOT (n)--()),
//     which only Neo4j is known to run.
// No template takes $parameters: the editor sends none (there is no parameters
// panel yet).
// =============================================================================

import type { GraphDialect } from '../cypher/quote';
import { quoteIdentifier } from '../cypher/quote';
import { PREVIEW_LIMIT } from './budgets';
import type { ISchemaView } from './schema';

/** One template. */
export interface IQueryTemplate {
	/** Stable per kind: sample, label, pattern, type, count-labels, count-types, isolated. */
	id: string;
	name: string;
	cypher: string;
}

/** The sample Explore runs, and the first template: safe on all three engines. */
export const EXPLORE_CYPHER = `MATCH (a)-[r]->(b) RETURN a, r, b LIMIT ${PREVIEW_LIMIT}`;

/**
 * Whether a schema entry is worth a template: it has data, or its count was not reported.
 *
 * @param count - The schema's count.
 * @returns False only for a count of zero.
 */
function hasData(count: number | null): boolean {
	return count !== 0;
}

/**
 * The templates to offer for a connection.
 *
 * @param schema - Its schema view, or null before one was read.
 * @param dialect - Its engine, or null before the node answered (then only the sample, which needs no quoting).
 * @returns The templates, in the order to show them.
 */
export function starterTemplates(schema: ISchemaView | null, dialect: GraphDialect | null): IQueryTemplate[] {
	const out: IQueryTemplate[] = [{ id: 'sample', name: 'Sample the graph', cypher: EXPLORE_CYPHER }];
	if (dialect === null) return out;

	if (schema) {
		const label = schema.labels.filter((l) => hasData(l.count)).map((l) => ({ name: l.name, quoted: quoteIdentifier(l.name, dialect) })).find((l) => l.quoted !== null);
		if (label) out.push({ id: 'label', name: `${PREVIEW_LIMIT} ${label.name} nodes`, cypher: `MATCH (n:${label.quoted}) RETURN n LIMIT ${PREVIEW_LIMIT}` });

		for (const type of schema.relationshipTypes) {
			if (!hasData(type.count)) continue;
			const quotedType = quoteIdentifier(type.type, dialect);
			if (quotedType === null) continue;
			const pair = type.endpoints
				.map((e) => ({ ...e, quotedStart: quoteIdentifier(e.start, dialect), quotedEnd: quoteIdentifier(e.end, dialect) }))
				.find((e) => e.quotedStart !== null && e.quotedEnd !== null);
			out.push(
				pair
					? { id: 'pattern', name: `${pair.start} ${type.type} ${pair.end}`, cypher: `MATCH (a:${pair.quotedStart})-[r:${quotedType}]->(b:${pair.quotedEnd}) RETURN a, r, b LIMIT ${PREVIEW_LIMIT}` }
					: { id: 'type', name: `${PREVIEW_LIMIT} ${type.type} relationships`, cypher: `MATCH (a)-[r:${quotedType}]->(b) RETURN a, r, b LIMIT ${PREVIEW_LIMIT}` }
			);
			break;
		}
	}

	if (dialect !== 'age') {
		out.push({ id: 'count-labels', name: 'Count nodes by label', cypher: 'MATCH (n) RETURN labels(n) AS labels, count(*) AS nodes ORDER BY nodes DESC' });
		out.push({ id: 'count-types', name: 'Relationship type counts', cypher: 'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS relationships ORDER BY relationships DESC' });
	}
	if (dialect === 'neo4j') out.push({ id: 'isolated', name: 'Nodes with no relationships', cypher: `MATCH (n) WHERE NOT (n)--() RETURN n LIMIT ${PREVIEW_LIMIT}` });
	return out;
}
