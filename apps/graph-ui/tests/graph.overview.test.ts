// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// OVERVIEW: THE MODEL BEHIND THE SCHEMA GRAPH, THE TILES AND THE CARDS
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseDialect } from '../src/graph/dialect';
import { buildOverview, countLabel, MAX_DRAWN_LABELS } from '../src/graph/overview';
import type { IOverviewInput } from '../src/graph/overview';
import { parseSchema } from '../src/graph/schema';
import { EMPTY_STYLE } from '../src/graph/userData';
import { fixture } from './support/builders';

const NOW = Date.parse('2026-10-04T15:04:00Z');
const view = parseSchema(fixture('schema_v2'));
const dialect = parseDialect(fixture('dialect_neo4j'));
const endpoint = { nodeName: 'Neo4j', pipelineName: 'Customer Graph' };
/** What the realm that owns the schema stored: slots for the labels, by name. */
const STYLE = { ...EMPTY_STYLE, assigned: { Company: 0, Person: 1 } };
const input = (over: Partial<IOverviewInput> = {}): IOverviewInput => ({ view, dialect, style: STYLE, ready: true, chipLabels: [], endpoint, now: NOW, ...over });

/** A v2 schema block with the given labels and relationship types. */
function schemaOf(labels: Array<Record<string, unknown>>, types: Array<Record<string, unknown>> = [], over: Record<string, unknown> = {}) {
	return parseSchema({ schema: { version: 2, labels, relationship_types: types, sampled: true, truncated: false, refreshed_at: '2026-10-04T15:00:00Z', source: 'refresh', stale: false, error: null, capable: true, ...over } });
}

test('a count says about when estimated, not reported when absent, and the number otherwise', () => {
	assert.equal(countLabel(1200, true), 'about 1,200');
	assert.equal(countLabel(1200, false), '1,200');
	assert.equal(countLabel(0, false), '0');
	assert.equal(countLabel(null, false), 'not reported');
	assert.equal(countLabel(null, true), 'not reported');
});

test('the tiles from the v2 fixture: estimated counts add up to an "about", per label, with the property keys sampled', () => {
	const m = buildOverview(input());
	assert.equal(m.state, 'ready');
	const t = Object.fromEntries(m.tiles.map((tile) => [tile.id, tile]));
	assert.equal(t.labels.value, '2');
	assert.equal(t.types.value, '3');
	assert.equal(t.nodes.value, 'about 3', 'Company 1 + Person 2, both estimates');
	assert.match(t.nodes.note, /per label/);
	assert.equal(t.relationships.value, 'not reported', 'LIKES and WORKS_AT have no count, so no total is claimed');
	assert.equal(t.keys.value, '6', 'age, born, name, role, score, since');
	assert.match(t.keys.note, /sampled/);
});

test('exact counts add up exactly; one missing count makes the total not reported; AGE has no per-label note', () => {
	const exact = schemaOf([{ name: 'A', properties: [], count: 5, count_estimated: false }, { name: 'B', properties: [], count: 7, count_estimated: false }], [{ type: 'R', endpoints: [{ start: 'A', end: 'B', observed: true }], properties: [], count: 4, count_estimated: false }]);
	const m = buildOverview(input({ view: exact }));
	assert.equal(m.tiles.find((t) => t.id === 'nodes')?.value, '12');
	assert.equal(m.tiles.find((t) => t.id === 'relationships')?.value, '4');
	const missing = schemaOf([{ name: 'A', properties: [], count: 5 }, { name: 'B', properties: [] }]);
	assert.equal(buildOverview(input({ view: missing })).tiles.find((t) => t.id === 'nodes')?.value, 'not reported');
	const age = parseDialect(fixture('dialect_age'));
	assert.equal(buildOverview(input({ view: exact, dialect: age })).tiles.find((t) => t.id === 'nodes')?.note, '');
});

test('label cards: counts as said, properties with their types, a preview and a new-query text', () => {
	const m = buildOverview(input());
	const person = m.labels.find((l) => l.name === 'Person');
	assert.ok(person);
	assert.equal(person.count, 'about 2');
	assert.deepEqual(person.properties.map((p) => `${p.name}:${p.types}`), ['age:INTEGER', 'born:TEMPORAL', 'name:STRING', 'score:FLOAT | INTEGER']);
	assert.equal(person.cypher, 'MATCH (n:`Person`) RETURN n LIMIT 25');
	assert.equal(person.refusal, null);
	assert.equal(m.labels.find((l) => l.name === 'Company')?.title, 'Company');
});

test('a label the engine cannot quote has no query and says why', () => {
	const odd = schemaOf([{ name: 'Has Space', properties: [] }]);
	const age = parseDialect(fixture('dialect_age'));
	const card = buildOverview(input({ view: odd, dialect: age })).labels[0];
	assert.equal(card.cypher, null);
	assert.match(card.refusal ?? '', /cannot be put in a generated query/);
});

test('the relationship table: type, patterns, count and properties', () => {
	const rows = buildOverview(input()).types;
	assert.deepEqual(rows.map((r) => r.type), ['KNOWS', 'LIKES', 'WORKS_AT']);
	const works = rows[2];
	assert.deepEqual(works.patterns.map((p) => [p.start, p.end, p.observed]), [['Person', 'Company', true], ['Employee', 'Company', false]]);
	assert.equal(works.count, 'not reported');
	assert.equal(works.properties, 'role STRING');
	assert.equal(rows[0].count, 'about 3');
	assert.equal(rows[0].properties, 'since INTEGER');
	assert.equal(rows[1].properties, '');
});

test('the schema graph: one circle per label in its label colour, one arrow per observed pattern between labels', () => {
	const g = buildOverview(input()).graph;
	assert.ok(g && g.kind === 'drawn');
	assert.deepEqual(g.nodes.map((n) => n.label), ['Company', 'Person']);
	assert.ok(g.nodes.every((n) => /^var\(--rr-chart-/.test(n.fill)));
	assert.notEqual(g.nodes[0].fill, g.nodes[1].fill, 'one colour per label');
	// KNOWS Person->Person (a loop), LIKES Person->Person (a loop), WORKS_AT Person->Company; Employee is not a label.
	assert.deepEqual(g.edges.map((e) => [e.type, e.from, e.to, e.observed]).sort(), [['KNOWS', 'Person', 'Person', true], ['LIKES', 'Person', 'Person', true], ['WORKS_AT', 'Person', 'Company', true]]);
	assert.equal(g.edges.filter((e) => e.loop).length, 2);
	assert.equal(g.undrawn, 1, 'the pattern from a label the schema does not list is in the table, not the picture');
	for (const n of g.nodes) assert.ok(n.x >= 0 && n.x <= g.width && n.y >= 0 && n.y <= g.height);
	for (const e of g.edges) assert.match(e.path, /^M [\d.-]+ [\d.-]+ (Q|A|C)/);
});

test('parallel patterns between the same two labels take different paths', () => {
	const v = schemaOf([{ name: 'A', properties: [] }, { name: 'B', properties: [] }], [{ type: 'X', endpoints: [{ start: 'A', end: 'B', observed: true }], properties: [] }, { type: 'Y', endpoints: [{ start: 'A', end: 'B', observed: true }, { start: 'B', end: 'A', observed: true }], properties: [] }]);
	const g = buildOverview(input({ view: v })).graph;
	assert.ok(g && g.kind === 'drawn');
	assert.equal(new Set(g.edges.map((e) => e.path)).size, 3);
});

test('colours are the connection\'s stored ones: a label keeps its slot when another is added', () => {
	const style = { ...EMPTY_STYLE, assigned: { Person: 3, Company: 0 } };
	const g = buildOverview(input({ style })).graph;
	assert.ok(g && g.kind === 'drawn');
	assert.equal(g.nodes.find((n) => n.label === 'Person')?.fill, 'var(--rr-chart-orange)');
});

test('past the drawing limit the graph is a list, and the cards still list every label', () => {
	const many = Array.from({ length: MAX_DRAWN_LABELS + 1 }, (_, i) => ({ name: `L${String(i).padStart(3, '0')}`, properties: [] }));
	const m = buildOverview(input({ view: schemaOf(many) }));
	assert.deepEqual(m.graph, { kind: 'list', labels: MAX_DRAWN_LABELS + 1 });
	assert.equal(m.labels.length, MAX_DRAWN_LABELS + 1);
	const exactly = buildOverview(input({ view: schemaOf(many.slice(0, MAX_DRAWN_LABELS)) }));
	assert.equal(exactly.graph?.kind, 'drawn');
});

test('states: not loaded, empty, error, stale, and an old node that proves nothing', () => {
	const loading = buildOverview(input({ view: null }));
	assert.equal(loading.state, 'loading');
	assert.equal(loading.tiles.length, 0);
	assert.equal(loading.graph, null);

	const empty = buildOverview(input({ view: schemaOf([]), dialect: parseDialect(fixture('dialect_falkordb')) }));
	assert.equal(empty.state, 'empty');
	assert.equal(empty.headline, 'This graph is empty');
	assert.match(empty.notice, /FalkorDB .* reports no labels and no relationship types for agent\. This is an empty graph, not a failed schema read\./);

	const error = buildOverview(input({ view: schemaOf([], [], { error: 'Schema reflection failed\nDatabase said: connection reset' }) }));
	assert.equal(error.state, 'unavailable');
	assert.match(error.notice, /last read failed/);

	const stale = buildOverview(input({ view: schemaOf([{ name: 'A', properties: [] }], [], { stale: true }) }));
	assert.equal(stale.state, 'ready');
	assert.match(stale.notice, /last refresh failed/);

	const old = buildOverview(input({ view: parseSchema(fixture('schema_old_node')) }));
	assert.notEqual(old.state, 'empty', 'an old node\'s empty answer is not an empty graph');
});

test('the empty wording needs fresh evidence: unknown evidence with nothing listed says it does not know', () => {
	const unknown = buildOverview(input({ view: parseSchema({ labels: [], nodes: {}, relationships: [] }) }));
	assert.equal(unknown.state, 'unknown');
	assert.match(unknown.notice, /does not report enough to say what the graph holds/);
	assert.doesNotMatch(unknown.headline, /empty/);
});

test('labels are drawn neutral until the style is ready', () => {
	const g = buildOverview(input({ ready: false })).graph;
	assert.ok(g && g.kind === 'drawn');
	assert.ok(g.nodes.every((n) => n.fill === 'var(--rr-grey-400)'));
	assert.ok(buildOverview(input({ ready: false })).labels.every((l) => l.fill === 'var(--rr-grey-400)'));
});

test('a truncated listing gives lower bounds, and the size line is the cards\' words', () => {
	const cut = schemaOf([{ name: 'A', properties: [], count: 5, count_estimated: false }], [], { truncated: true });
	const m = buildOverview(input({ view: cut }));
	assert.equal(m.tiles.find((t) => t.id === 'nodes')?.value, 'at least 5');
	assert.equal(m.size, 'At least 5 nodes (per label)');
	assert.equal(buildOverview(input()).size, 'About 3 nodes (per label) · some relationship counts not reported');
});

test('a read that lists nothing and proves nothing never reads as zero', () => {
	assert.equal(buildOverview(input({ view: parseSchema(null) })).headline, 'Could not be read', 'a load that failed outright');
	assert.equal(buildOverview(input({ view: parseSchema({ labels: [], nodes: {}, relationships: [] }) })).headline, 'Not reported by this node', 'an old node\'s empty answer');
	const incapable = buildOverview(input({ view: schemaOf([], [], { capable: false }) }));
	assert.equal(incapable.state, 'unavailable');
	assert.equal(incapable.headline, 'Not reported by this node');
});

test('the heading line names the engine, the database or graph, the route and the schema\'s age', () => {
	const m = buildOverview(input());
	assert.match(m.subtitle, /^Neo4j 5\.26\.31 Community · database neo4j · via Customer Graph \/ Neo4j · schema refreshed 4 minutes ago/);
});

test('the chips say what the counts are and that property keys are sampled', () => {
	const chips = buildOverview(input()).chips;
	assert.deepEqual(buildOverview(input({ chipLabels: ['Supported (Cypher)', 'Read-only'] })).chips.slice(0, 2), ['Supported (Cypher)', 'Read-only'], 'the cards\' chips come first, in their words');
	const caption = chips[chips.length - 1];
	assert.match(caption, /counts are estimates/i);
	assert.match(caption, /property keys are sampled/);
	const exact = schemaOf([{ name: 'A', properties: [], count: 1, count_estimated: false }]);
	assert.match(buildOverview(input({ view: exact })).chips.slice(-1)[0], /^Counts are exact/);
	const none = schemaOf([{ name: 'A', properties: [] }]);
	assert.match(buildOverview(input({ view: none })).chips.slice(-1)[0], /does not report counts/);
});

// -----------------------------------------------------------------------------
// The component: no request of its own
// -----------------------------------------------------------------------------

const SRC = path.resolve(__dirname, '..', 'src');
const code = (file: string): string => fs.readFileSync(path.join(SRC, ...file.split('/')), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the Overview sends nothing: it reads the loaded schema and calls the props', () => {
	const panel = code('components/OverviewPanel.tsx') + code('components/SchemaGraph.tsx');
	assert.doesNotMatch(panel, /readQuery|invoke\(|session|fetch\(|useEffect/, 'no request, no effect');
	assert.match(panel, /useSchemaView\(endpoint\.key\)/);
	for (const prop of ['onPreview', 'onNewQuery', 'onExplore', 'onRefreshSchema']) assert.match(panel, new RegExp(prop), prop);
});

test('the schema graph is a static SVG with no script, and it is named for assistive technology', () => {
	const svg = code('components/SchemaGraph.tsx');
	assert.match(svg, /<svg[\s\S]*role="img"/);
	assert.doesNotMatch(svg, /onClick|onMouse|<script/);
	assert.doesNotMatch(svg, /d3-|@xyflow/);
});
