// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// STARTER TEMPLATES: reads only, filled from the connection's own schema, and
// only what each engine runs
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatement } from '../src/cypher/classify';
import type { GraphDialect } from '../src/cypher/quote';
import { parseSchema } from '../src/graph/schema';
import type { ISchemaView } from '../src/graph/schema';
import { EXPLORE_CYPHER, starterTemplates } from '../src/graph/templates';
import { fixture } from './support/builders';

const DIALECTS: GraphDialect[] = ['neo4j', 'falkordb', 'age'];
const live = (engine: GraphDialect): ISchemaView => parseSchema(fixture(`live/${engine}_get_schema`, 'v1'));

/** A schema view with these labels and relationship types (name and count). */
function schemaOf(labels: [string, number | null][], types: { type: string; count: number | null; endpoints: [string, string][] }[]): ISchemaView {
	return {
		evidence: 'fresh',
		labels: labels.map(([name, count]) => ({ name, properties: [], count, countEstimated: false })),
		relationshipTypes: types.map((t) => ({ type: t.type, endpoints: t.endpoints.map(([start, end]) => ({ start, end, observed: true })), properties: [], count: t.count, countEstimated: false })),
		sampled: true,
		truncated: false,
		refreshedAt: null,
		source: 'startup',
		error: null,
		legacy: false,
	};
}

/** Every name a template could only have taken from the schema: labels and types inside `(x:Name)` and `[r:NAME]`. */
function schemaNamesIn(cypher: string): string[] {
	return [...cypher.matchAll(/[([]\w+:(`[^`]+`|\w+)/g)].map((m) => m[1].replace(/^`|`$/g, ''));
}

test('every template is a read the browse editor sends, for every engine it is offered on', () => {
	for (const dialect of DIALECTS) {
		for (const template of starterTemplates(live(dialect), dialect)) {
			const verdict = classifyStatement(template.cypher);
			assert.equal(verdict.kind, 'read', `${dialect} ${template.id}: ${template.cypher} (${verdict.findings.map((f) => f.word).join(', ')})`);
		}
	}
});

test('templates use only labels and relationship types the connection\'s schema has', () => {
	for (const dialect of DIALECTS) {
		const schema = live(dialect);
		const labels = new Set(schema.labels.map((l) => l.name));
		const types = new Set(schema.relationshipTypes.map((t) => t.type));
		const templates = starterTemplates(schema, dialect);
		assert.ok(templates.some((t) => t.id === 'label'), `${dialect}: a label template`);
		assert.ok(templates.some((t) => t.id === 'pattern'), `${dialect}: a pattern template`);
		for (const template of templates) {
			for (const name of schemaNamesIn(template.cypher)) assert.ok(labels.has(name) || types.has(name), `${dialect} ${template.id}: ${name} is not in the schema`);
		}
	}
});

test('the label and pattern templates are filled from the first label and type with data, quoted for the engine', () => {
	const schema = schemaOf([['Empty', 0], ['Has Space', 3], ['Person', 2], ['Company', null]], [{ type: 'EMPTY_TYPE', count: 0, endpoints: [['Person', 'Person']] }, { type: 'WORKS_AT', count: 1, endpoints: [['Has Space', 'Company'], ['Person', 'Company']] }]);
	const neo = starterTemplates(schema, 'neo4j');
	assert.equal(neo.find((t) => t.id === 'label')?.cypher, 'MATCH (n:`Has Space`) RETURN n LIMIT 25', 'a label with no data is skipped; Neo4j quotes a space');
	const age = starterTemplates(schema, 'age');
	assert.equal(age.find((t) => t.id === 'label')?.cypher, 'MATCH (n:Person) RETURN n LIMIT 25', 'AGE cannot quote a space, so the next label is used');
	assert.equal(age.find((t) => t.id === 'pattern')?.cypher, 'MATCH (a:Person)-[r:WORKS_AT]->(b:Company) RETURN a, r, b LIMIT 25');
	assert.equal(age.find((t) => t.id === 'pattern')?.name, 'Person WORKS_AT Company');
	assert.equal(neo.find((t) => t.id === 'pattern')?.cypher, 'MATCH (a:`Has Space`)-[r:`WORKS_AT`]->(b:`Company`) RETURN a, r, b LIMIT 25', 'a type with no data is skipped; Neo4j quotes every name');
});

test('a relationship type without an endpoint the engine can quote gets the type-only template', () => {
	const schema = schemaOf([['Person', 1]], [{ type: 'KNOWS', count: 2, endpoints: [] }]);
	const neo = starterTemplates(schema, 'neo4j');
	assert.equal(neo.find((t) => t.id === 'pattern'), undefined);
	assert.equal(neo.find((t) => t.id === 'type')?.cypher, 'MATCH (a)-[r:`KNOWS`]->(b) RETURN a, r, b LIMIT 25');
});

test('Apache AGE gets no CALL, no ORDER BY on an alias, no labels() or type(), and no pattern predicate', () => {
	const age = starterTemplates(live('age'), 'age');
	for (const template of age) {
		assert.doesNotMatch(template.cypher, /\bCALL\b|ORDER BY|labels\(|type\(|WHERE NOT \(/i, template.id);
	}
	assert.deepEqual(age.map((t) => t.id), ['sample', 'label', 'pattern']);
	assert.ok(starterTemplates(live('neo4j'), 'neo4j').some((t) => t.id === 'count-labels'));
	assert.ok(starterTemplates(live('falkordb'), 'falkordb').some((t) => t.id === 'count-types'));
});

// What Apache AGE's node refuses outright (NODE-FACTS section 4, probed on AGE 1.5.0): none of it may reach an AGE template.
test('every template offered on Apache AGE avoids what its node refuses', () => {
	const refused: [RegExp, string][] = [
		[/\bRETURN\s+\*/i, 'RETURN *'],
		[/\bORDER\s+BY\b/i, 'ORDER BY (on an alias it is refused)'],
		[/\bWHERE\s+\(?\w+:/i, 'a label predicate'],
		[/\(\w*:[^)\s{]+:[^)\s{]+/, 'several labels on one node'],
		[/\belementId\s*\(/i, 'elementId()'],
		[/\b(all)?shortestPath\s*\(/i, 'shortestPath()'],
		[/\b(datetime|date|time|localtime|localdatetime|duration)\s*\(/i, 'temporal functions'],
		[/\bEXISTS\s*[{(]|=~|\[\s*\w+\s+IN\b/i, 'EXISTS, regex or a list comprehension'],
		[/\bMERGE\b|\bCALL\b/i, 'MERGE or CALL'],
		[/\[[^\]]*:\w+\|/, 'relationship type alternation'],
		[/\*\s*\]|\*\.\.\s*\]/, 'unbounded variable length'],
	];
	for (const template of starterTemplates(live('age'), 'age')) {
		for (const [pattern, what] of refused) assert.doesNotMatch(template.cypher, pattern, `${template.id}: ${what}`);
	}
});

test('no template takes parameters until a parameters panel exists', () => {
	for (const dialect of DIALECTS) for (const template of starterTemplates(live(dialect), dialect)) assert.doesNotMatch(template.cypher, /\$\w/, `${dialect} ${template.id}`);
});

test('with no schema or no engine yet, only the schema-free sample is offered', () => {
	assert.deepEqual(starterTemplates(null, 'neo4j').map((t) => t.id), ['sample', 'count-labels', 'count-types', 'isolated']);
	assert.deepEqual(starterTemplates(live('neo4j'), null).map((t) => t.id), ['sample']);
	assert.equal(starterTemplates(null, null)[0].cypher, EXPLORE_CYPHER);
	assert.equal(EXPLORE_CYPHER, 'MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 25');
});
