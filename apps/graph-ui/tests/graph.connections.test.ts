// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONNECTION CARDS AND EMPTY STATES
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { fakeWorld, manualClock, row } from 'shared/explorer/connect/testing';
import { makeGraphEndpointStore } from '../src/adapters/explorer';
import { DETAILS_CLOSED, RECHECKING_TEXT, connectionChips, detailSections, connectionRow, connectionView, countsText, detailsPanelAfter, drawerKeyAfter, emptyState, landingView, ownerText, rowStatusText, schemaSummaryText, sidebarListLine, sizeText, surfaceGate, testResultText } from '../src/graph/connections';
import { NO_SCHEMA, parseSchema } from '../src/graph/schema';
import type { ISchemaView } from '../src/graph/schema';
import { fixture } from './support/builders';

function endpoint(over: Partial<IExplorerEndpoint> = {}): IExplorerEndpoint {
	return { key: 'k1|dev|user|u1|t1|p1|tools=tools_1|graph_1', legacyKey: null, projectId: 'p1', pipelineName: 'Social graph', runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't1', roles: { tools: { source: 'tools_1' } }, missingRoles: [], source: 'tools_1', nodeId: 'graph_1', nodeName: 'Neo4j', provider: 'graph_neo4j', state: 'ready', running: true, ...over };
}
const probeOf = (name: string): IProbeResult => ({ ok: true, info: fixture<Record<string, unknown>>(`dialect_${name}`), dialect: name });
const failed = (message: string): IProbeResult => ({ ok: false, info: null, dialect: null, error: { kind: 'raised', message } });

test('a ready current node shows engine, target, writes, owner and an honest read-boundary note', () => {
	const view = connectionView(endpoint(), probeOf('neo4j'));
	assert.equal(view.badge.label, 'Running');
	assert.equal(view.openable, true);
	assert.equal(view.blocked, null);
	const rows = Object.fromEntries(view.details.map((d) => [d.label, d.value]));
	assert.equal(rows.Engine, 'Neo4j 5.26.31 Community');
	assert.equal(rows.Target, 'database neo4j');
	assert.equal(rows.Writes, 'Off (browsing only)');
	assert.equal(rows.Run, 'development run, user u1 (team t1)');
	assert.ok(view.notes.some((n) => /read-only session, which is a routing hint and not access control/.test(n)));
	assert.ok(!JSON.stringify(view).toLowerCase().includes('password'));
});

test('writes are shown as allowed only when the node says execute is on', () => {
	const on = { ok: true, info: { ...fixture<Record<string, unknown>>('dialect_neo4j'), allow_execute: true }, dialect: 'neo4j' } satisfies IProbeResult;
	assert.equal(connectionView(endpoint(), on).details.find((d) => d.label === 'Writes')?.value, 'Allowed (execute is on for this node)');
});

test('an OLD node is badged Needs upgrade and cannot be opened; it is not shown as healthy', () => {
	const view = connectionView(endpoint(), probeOf('old_node'));
	assert.equal(view.badge.label, 'Needs upgrade');
	assert.equal(view.badge.variant, 'warning');
	assert.equal(view.openable, false);
	assert.match(view.blocked ?? '', /needs an upgrade/);
	assert.ok(view.notes.some((n) => /does not support read_query/.test(n)));
});

test('stopped, unreachable and inaccessible endpoints say why they cannot be opened', () => {
	assert.match(connectionView(endpoint({ state: 'stopped', running: false }), undefined).blocked ?? '', /stopped/);
	assert.match(connectionView(endpoint({ state: 'unreachable', stateDetail: 'Node graph_1 not found in pipeline' }), undefined).blocked ?? '', /not found in pipeline/);
	assert.match(connectionView(endpoint({ state: 'inaccessible' }), undefined).blocked ?? '', /not allowed to call/);
	for (const state of ['stopped', 'unreachable', 'inaccessible'] as const) assert.equal(connectionView(endpoint({ state }), undefined).openable, false);
	assert.equal(connectionView(endpoint({ state: 'probing' }), undefined).openable, false, 'not before the probe answered');
});

test('a ready endpoint whose probe failed is blocked with the node\'s first line', () => {
	const view = connectionView(endpoint(), failed('Unexpected node answer\nsecond line'));
	assert.equal(view.blocked, 'Unexpected node answer');
	assert.equal(view.openable, false);
});

test('a deployment is named as one and shows the owning team, not the selected organization', () => {
	assert.equal(ownerText(endpoint({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-9', teamId: 'team-9' })), 'deployment, team team-9');
	assert.equal(ownerText(endpoint({ runKind: 'deploy', ownerKind: 'user', ownerId: 'u7', teamId: '' })), 'deployment, user u7');
	assert.match(connectionView(endpoint({ runKind: 'deploy' }), undefined).address, /\(deployment\)$/);
});

test('empty states: loading, error, none running (cause unknown) and unreachable', () => {
	assert.equal(emptyState('idle', [], null)?.kind, 'loading');
	assert.equal(emptyState('loading', [], null)?.kind, 'loading');
	assert.equal(emptyState('error', [], 'getTasks failed')?.kind, 'error');
	const none = emptyState('ready', [], null);
	assert.equal(none?.kind, 'none-running');
	assert.match(none?.unknown ?? '', /does not appear in this list at all/);
	assert.ok(!/not provisioned|unprovisioned|does not exist/i.test(`${none?.title} ${none?.description}`), 'an empty list never claims the graph is missing');
	assert.equal(emptyState('ready', [endpoint({ state: 'unreachable' })], null)?.kind, 'unreachable');
	assert.equal(emptyState('ready', [endpoint({ state: 'stopped' }), endpoint({ key: 'b', state: 'inaccessible' })], null)?.kind, 'unreachable');
	assert.equal(emptyState('ready', [endpoint()], null), null, 'something is usable: nothing to say');
	assert.equal(emptyState('loading', [endpoint()], null), null, 'cached endpoints stay visible while refreshing');
});

// The page has no "graph does not exist yet" state keyed on a probe's wording. The probe (`dialect`) never touches
// the database, and a graph that does not exist stops the node at pipeline start, so the node never appears here at
// all. Nothing a listed node answers can say a graph is missing, so the page never says it (and does not read probe
// text to decide what to claim).
test('the page never claims a graph does not exist: a node that cannot be used is unreachable, and a missing graph is named among the start-up failures it cannot see', () => {
	const e = endpoint({ state: 'unreachable', stateDetail: 'Graph "rocketride" does not exist' });
	const said = emptyState('ready', [e], null);
	assert.equal(said?.kind, 'unreachable');
	assert.doesNotMatch(`${said?.title} ${said?.description}`, /does not exist/);
	const none = emptyState('ready', [], null);
	assert.match(none?.unknown ?? '', /does not appear in this list at all/);
	assert.match(none?.unknown ?? '', /graph that does not exist/, 'a missing graph is one reason a node is not listed');
	assert.match(none?.unknown ?? '', /pipeline.s log/);
});

test('failed discovery keeps already discovered endpoints visible instead of an empty state', () => {
	assert.equal(emptyState('error', [endpoint()], 'refresh failed'), null);
});

// -----------------------------------------------------------------------------
// The landing keeps its cards when no endpoint is ready
// -----------------------------------------------------------------------------
//
// "Graph nodes found, but none can be used" never replaces the card grid, and 'probing' does not count as unusable:
// a first load or a re-probe must not say a node is unusable while it is still being checked. In the genuine
// stopped / unreachable / No access cases the cards stay, so the reason and Test connection that the message points
// to ("Each card says why") can be reached.

test('while a node is still being checked, the landing claims nothing about it: its card says Checking', () => {
	assert.equal(emptyState('ready', [endpoint({ state: 'probing' })], null), null);
	assert.equal(emptyState('loading', [endpoint({ state: 'probing' })], null), null);
	assert.equal(emptyState('ready', [endpoint({ state: 'probing' }), endpoint({ key: 'b', state: 'stopped', running: false })], null), null, 'a node still being checked may yet be usable');
	assert.equal(connectionView(endpoint({ state: 'probing' }), undefined).badge.label, 'Checking');
});

test('a first discovery whose probe is still in flight shows the card, not "none can be used"', async () => {
	let release: () => void = () => undefined;
	const dialect = fixture<Record<string, unknown>>('dialect_neo4j');
	const world = fakeWorld([row({ pipeline: { project_id: 'proj-g', name: 'Graph pipeline', components: [{ id: 'graph_1', provider: 'graph_neo4j', name: 'Graph' }] } })], (call) => (call.tool === 'dialect' ? new Promise((resolve) => { release = () => resolve(dialect); }) : {}));
	const clock = manualClock();
	const store = makeGraphEndpointStore({ clock });
	const first = store.refresh(world.client);
	await clock.settle();
	const during = store.getState();
	assert.equal(during.endpoints[0]?.state, 'probing', 'the probe really is in flight');
	assert.equal(emptyState(during.status, during.endpoints, during.error), null, 'no "none can be used" while the probe is in flight');
	assert.deepEqual(landingView(during.status, during.endpoints, during.error), { message: null, cards: true });
	release();
	await first;
	await clock.settle();
	const after = store.getState();
	assert.deepEqual(landingView(after.status, after.endpoints, after.error), { message: null, cards: true });
});

test('the landing keeps its cards under the message whenever there are cards, and shows the message alone only when there are none', () => {
	const blocked = landingView('ready', [endpoint({ state: 'stopped', running: false }), endpoint({ key: 'b', state: 'inaccessible' })], null);
	assert.equal(blocked.message?.kind, 'unreachable');
	assert.equal(blocked.cards, true, 'each card, its reason and Test connection stay reachable');
	assert.equal(landingView('loading', [endpoint({ state: 'unreachable' })], null).cards, true, 'a refresh keeps the cards');
	for (const [status, kind] of [['idle', 'loading'], ['loading', 'loading'], ['error', 'error'], ['ready', 'none-running']] as const) {
		const alone = landingView(status, [], status === 'error' ? 'getTasks failed' : null);
		assert.equal(alone.message?.kind, kind, status);
		assert.equal(alone.cards, false, `${status}: no card to show`);
	}
	assert.deepEqual(landingView('ready', [endpoint()], null), { message: null, cards: true });
});

test('a node that advertises read_query is not badged as needing an upgrade, and one that says false is', () => {
	const current = connectionView(endpoint(), probeOf('neo4j'));
	assert.equal(current.badge.label, 'Running');
	assert.equal(current.openable, true);
	assert.equal(connectionView(endpoint(), { ok: true, info: { dialect: 'neo4j', capabilities: { read_query: false } }, dialect: 'neo4j' }).badge.label, 'Needs upgrade');
});

// -----------------------------------------------------------------------------
// A re-probe must not take an open workbench away
// -----------------------------------------------------------------------------

test('an open workbench stays on screen while its connection is checked again (a restart elsewhere, a reconnect, Test connection), and running pauses until it answers', async () => {
	const dialect = fixture<Record<string, unknown>>('dialect_neo4j');
	let hold = false;
	let release: () => void = () => undefined;
	const world = fakeWorld([row({ pipeline: { project_id: 'proj-g', name: 'Graph pipeline', components: [{ id: 'graph_1', provider: 'graph_neo4j', name: 'Graph' }] } })], (call) => {
		if (call.tool === 'dialect') return hold ? new Promise((resolve) => { release = () => resolve(dialect); }) : dialect;
		return {};
	});
	const clock = manualClock();
	const store = makeGraphEndpointStore({ clock });
	await store.refresh(world.client);
	await clock.settle();
	const gate = (opened: boolean) => {
		const s = store.getState();
		const e = s.endpoints[0];
		return surfaceGate(connectionView(e, s.probes[e.key]), opened);
	};
	assert.deepEqual(gate(false), { mounted: true, paused: null }, 'a ready connection opens');

	// Any task restart (from ANY pipeline) and every shell reconnect ask for refresh({ reprobe: true }).
	hold = true;
	const reprobe = store.refresh(world.client, { reprobe: true });
	await clock.settle();
	assert.equal(store.getState().endpoints[0].state, 'probing', 'the store really is re-checking');
	const during = gate(true);
	assert.equal(during.mounted, true, 'the editor, results, graph and inspector stay mounted');
	assert.equal(during.paused, RECHECKING_TEXT, 'running pauses, and says why');
	assert.deepEqual(gate(false), { mounted: false, paused: null }, 'a document that never opened keeps its empty state');
	release();
	await reprobe;
	await clock.settle();
	assert.deepEqual(gate(true), { mounted: true, paused: null }, 'running resumes once the node answers');

	// The drawer's Test connection does the same.
	const test = store.probe(world.client, store.getState().endpoints[0].key);
	await clock.settle();
	assert.equal(gate(true).mounted, true);
	assert.equal(gate(true).paused, RECHECKING_TEXT);
	release();
	await test;
	assert.deepEqual(gate(true), { mounted: true, paused: null });
});

test('a stopped or blocked connection keeps an open surface but pauses it with the card\'s reason', () => {
	const stopped = surfaceGate(connectionView(endpoint({ state: 'stopped', running: false }), undefined), true);
	assert.equal(stopped.mounted, true);
	assert.match(stopped.paused ?? '', /stopped/);
	const upgrade = surfaceGate(connectionView(endpoint(), probeOf('old_node')), true);
	assert.equal(upgrade.mounted, true);
	assert.match(upgrade.paused ?? '', /needs an upgrade/);
});

// -----------------------------------------------------------------------------
// What Test connection says, and for which card
// -----------------------------------------------------------------------------

test('Test connection says "not tested" when nothing was sent, never that the node did not answer', () => {
	const skipped = testResultText(null);
	assert.equal(skipped.variant, 'warning');
	assert.match(skipped.text, /^Not tested: /);
	assert.doesNotMatch(skipped.text, /did not answer/);
	assert.deepEqual(testResultText(probeOf('neo4j')), { variant: 'info', text: 'The node answered.' });
	const failedProbe = testResultText(failed('connection refused'));
	assert.equal(failedProbe.variant, 'error');
	assert.match(failedProbe.text, /did not answer its identity probe/);
});

// A sign-out or a change of user, organization or team resets the endpoint store. The connection drawer stayed open
// on its key, so when discovery under the new identity listed the same key it reappeared on its own, still showing
// the previous identity's Test result.
test('the connection drawer keeps its card while the store lists it and closes once the store forgets it', async () => {
	assert.equal(drawerKeyAfter(null, [endpoint()]), null);
	assert.equal(drawerKeyAfter(endpoint().key, [endpoint()]), endpoint().key);
	assert.equal(drawerKeyAfter(endpoint().key, [endpoint({ key: 'other' })]), null);
	assert.equal(drawerKeyAfter(endpoint().key, []), null);

	const world = fakeWorld([row({ pipeline: { project_id: 'proj-g', name: 'Graph pipeline', components: [{ id: 'graph_1', provider: 'graph_neo4j', name: 'Graph' }] } })], (call) => (call.tool === 'dialect' ? fixture<Record<string, unknown>>('dialect_neo4j') : {}));
	const clock = manualClock();
	const store = makeGraphEndpointStore({ clock });
	await store.refresh(world.client);
	await clock.settle();
	const key = store.getState().endpoints[0]?.key ?? null;
	assert.ok(key, 'discovery found the node');

	world.rows = [];
	await store.refresh(world.client);
	await clock.settle();
	assert.equal(drawerKeyAfter(key, store.getState().endpoints), key, 'a node that stopped stays listed, so its drawer stays open');

	store.reset();
	assert.equal(drawerKeyAfter(key, store.getState().endpoints), null, 'a reset forgets every connection, so the drawer closes');
});

// The dev-tool sidebar lists the connections as rows (Rod's anatomy): a state dot plus a text suffix, never colour
// alone, and a tooltip that says which pipeline and why a row cannot be browsed.
test('a sidebar row says its state in words: no suffix for a running node, the card\'s badge label otherwise', () => {
	assert.equal(rowStatusText(endpoint(), probeOf('neo4j')), null, 'a running node needs no suffix');
	assert.equal(rowStatusText(endpoint({ state: 'probing' }), undefined), 'Checking');
	assert.equal(rowStatusText(endpoint({ state: 'stopped', running: false }), undefined), 'Stopped');
	assert.equal(rowStatusText(endpoint({ state: 'unreachable' }), undefined), 'Unreachable');
	assert.equal(rowStatusText(endpoint({ state: 'inaccessible' }), undefined), 'No access');
	assert.equal(rowStatusText(endpoint(), probeOf('old_node')), 'Needs upgrade', 'the same word as the card');
});

test('a sidebar row carries a tooltip and an accessible name that include its state, and its dot variant is the card\'s', () => {
	const running = connectionRow(endpoint(), probeOf('neo4j'));
	assert.deepEqual({ label: running.label, status: running.status, variant: running.variant }, { label: 'Neo4j', status: null, variant: 'success' });
	assert.equal(running.tooltip, 'Neo4j \u2014 graph_neo4j \u00b7 Neo4j 5.26.31 Community \u00b7 Social graph \u00b7 Running \u00b7 Read-only', 'the engine and whether it writes');
	assert.equal(running.ariaLabel, 'Neo4j, Running');
	const stopped = connectionRow(endpoint({ state: 'stopped', running: false }), undefined);
	assert.equal(stopped.variant, 'muted');
	assert.equal(stopped.ariaLabel, 'Neo4j, Stopped');
	assert.match(stopped.tooltip, /\u00b7 Stopped\nThe pipeline is stopped\. Start it to browse this graph\.$/, 'the reason follows on its own line');
	const deployed = connectionRow(endpoint({ runKind: 'deploy' }), probeOf('neo4j'));
	assert.match(deployed.tooltip, /Social graph \(deployment\) \u00b7 Running \u00b7 Read-only$/);
	const writable = connectionRow(endpoint(), { ok: true, info: { ...fixture<Record<string, unknown>>('dialect_neo4j'), allow_execute: true }, dialect: 'neo4j' });
	assert.match(writable.tooltip, /\u00b7 Running \u00b7 Writes allowed$/);
	assert.ok(!JSON.stringify([running, stopped]).toLowerCase().includes('password'));
});

test('the line under the sidebar rows: discovering, none running (with what cannot be known), discovery failed; nothing before discovery starts or while rows say it all', () => {
	assert.equal(sidebarListLine('idle', [], null), null, 'nothing asked yet (discovery waits for the activation and a known identity): no "discovering" claim');
	assert.deepEqual(sidebarListLine('loading', [], null), { tone: 'muted', text: 'Discovering graph nodes\u2026', detail: null });
	assert.equal(sidebarListLine('loading', [endpoint()], null), null, 'a refresh with rows on screen says nothing');
	const none = sidebarListLine('ready', [], null);
	assert.equal(none?.tone, 'muted');
	assert.equal(none?.text, 'No running graph node found. Start a pipeline with a graph node, then refresh.');
	assert.match(none?.detail ?? '', /fails to start does not appear in this list at all/, 'what an empty list cannot tell, in the tooltip');
	const failedLine = sidebarListLine('error', [], 'socket closed');
	assert.deepEqual({ tone: failedLine?.tone, text: failedLine?.text }, { tone: 'error', text: 'Discovery failed: socket closed' });
	assert.match(failedLine?.detail ?? '', /Nothing is known about which graph nodes are running/);
	assert.deepEqual(sidebarListLine('error', [endpoint()], 'socket closed'), { tone: 'error', text: 'Refresh failed: socket closed. Showing what was found before.', detail: null }, 'the rows stay');
	assert.equal(sidebarListLine('ready', [endpoint({ state: 'stopped', running: false })], null), null, 'each row says why it cannot be used');
});

// A dev-tool document shows the connection details inline (CE-1): Details toggles them, Test connection opens them and
// tests, and every Test connection asked while they are open tests again. A panel opened by Details never tests.
test('the inline details panel: Details toggles, Test connection opens and asks for a test each time, close forgets the requests', () => {
	assert.deepEqual(DETAILS_CLOSED, { open: false, testRequest: 0 });
	const shown = detailsPanelAfter(DETAILS_CLOSED, 'toggle');
	assert.deepEqual(shown, { open: true, testRequest: 0 }, 'opened by Details: nothing is tested');
	assert.deepEqual(detailsPanelAfter(shown, 'toggle'), DETAILS_CLOSED, 'Details again closes it');
	const tested = detailsPanelAfter(DETAILS_CLOSED, 'test');
	assert.deepEqual(tested, { open: true, testRequest: 1 }, 'Test connection opens it and asks for a test');
	assert.deepEqual(detailsPanelAfter(tested, 'test'), { open: true, testRequest: 2 }, 'asked again while open: a new request');
	assert.deepEqual(detailsPanelAfter(shown, 'test'), { open: true, testRequest: 1 });
	assert.deepEqual(detailsPanelAfter(tested, 'close'), DETAILS_CLOSED);
	assert.deepEqual(detailsPanelAfter(detailsPanelAfter(tested, 'close'), 'toggle'), { open: true, testRequest: 0 }, 'a reopened panel does not test again by itself');
});

// =============================================================================
// CARDS AND THE DRAWER: chips, counts and the schema line (M12)
// =============================================================================

const view = (over: Partial<ISchemaView> = {}): ISchemaView => ({ ...parseSchema(fixture('schema_v2')), ...over });
const label = (name: string, count: number | null, countEstimated = false) => ({ name, properties: [], count, countEstimated });
const type = (name: string, count: number | null, countEstimated = false) => ({ type: name, endpoints: [], properties: [], count, countEstimated });
const chipLabels = (...args: Parameters<typeof connectionChips>) => connectionChips(...args).map((chip) => chip.label);

test('chips for the three engines: Supported (Cypher), and Writes allowed or Read-only, from the node\'s own answer', () => {
	assert.deepEqual(chipLabels(endpoint(), probeOf('neo4j'), null), ['Supported (Cypher)', 'Read-only']);
	assert.deepEqual(chipLabels(endpoint({ provider: 'graph_falkordb' }), probeOf('falkordb'), null), ['Supported (Cypher)', 'Read-only']);
	assert.deepEqual(chipLabels(endpoint({ provider: 'rocketride_graph' }), probeOf('age'), null), ['Supported (Cypher)', 'Read-only']);
	const writable: IProbeResult = { ok: true, info: { ...fixture<Record<string, unknown>>('dialect_neo4j'), allow_execute: true }, dialect: 'neo4j' };
	assert.deepEqual(chipLabels(endpoint(), writable, null), ['Supported (Cypher)', 'Writes allowed']);
	assert.deepEqual(chipLabels(endpoint(), probeOf('old_node'), null), [], 'an old node: its badge says Needs upgrade, and nothing it cannot do is claimed');
	assert.deepEqual(chipLabels(endpoint(), undefined, null), [], 'nothing before the node answered');
	assert.deepEqual(chipLabels(endpoint(), failed('down'), null), []);
});

test('"Empty graph" only for a fresh schema with no labels and no relationship types, never for unknown evidence', () => {
	const empty = view({ evidence: 'fresh', labels: [], relationshipTypes: [] });
	assert.ok(chipLabels(endpoint(), probeOf('falkordb'), empty).includes('Empty graph'));
	assert.ok(!chipLabels(endpoint(), probeOf('falkordb'), { ...empty, evidence: 'unknown' }).includes('Empty graph'));
	assert.ok(!chipLabels(endpoint(), probeOf('falkordb'), { ...empty, evidence: 'stale' }).includes('Empty graph'));
	assert.ok(!chipLabels(endpoint(), probeOf('falkordb'), view({ evidence: 'fresh' })).includes('Empty graph'));
});

test('counts: exact sums; "about" on an estimate; "not reported" for a part whose counts are absent (AGE before ANALYZE)', () => {
	assert.equal(countsText(view({ labels: [label('A', 20), label('B', 40)], relationshipTypes: [type('R', 90), type('S', 2)] })), '60 nodes (per label) \u00b7 92 relationships');
	assert.equal(countsText(view({ labels: [label('A', 1, true), label('B', 2)], relationshipTypes: [type('R', 1)] })), 'about 3 nodes (per label) \u00b7 1 relationship');
	assert.equal(countsText(view({ labels: [label('A', null), label('B', 2)], relationshipTypes: [type('R', 5, true)] })), 'some node counts not reported \u00b7 about 5 relationships', 'a label without a count: no node total, and it says some are missing');
	assert.equal(countsText(view({ labels: [label('A', null), label('B', null)], relationshipTypes: [type('R', 5)] })), 'nodes not reported \u00b7 5 relationships', 'no label counted at all');
	assert.equal(countsText(view({ labels: [label('A', null), label('B', 3)], relationshipTypes: [type('R', null), type('S', 1)] })), 'some counts not reported', 'nothing totalled, but some counts exist');
	assert.equal(countsText(view({ labels: [label('A', 4)], relationshipTypes: [type('R', null)] })), '4 nodes (per label) \u00b7 relationships not reported');
	assert.equal(countsText(view({ labels: [label('A', null)], relationshipTypes: [type('R', null)] })), 'counts not reported', 'AGE with no counts at all');
	assert.equal(countsText(view({ labels: [label('A', null)], relationshipTypes: [] })), 'counts not reported');
	assert.equal(countsText(view({ labels: [], relationshipTypes: [] })), '', 'an empty graph says so with its chip');
	assert.equal(countsText(null), '', 'not read in this session: no counts, and no request for them');
	assert.equal(countsText(view({ labels: [label('A', 1_234_567)], relationshipTypes: [] })), '1,234,567 nodes (per label)');
	assert.equal(countsText(view({ truncated: true, labels: [label('A', 1)], relationshipTypes: [type('R', 1, true)] })), 'at least 1 node (per label) \u00b7 at least about 1 relationship', 'a listing cut short: the sums are lower bounds');
});

test('the drawer\'s size and schema lines', () => {
	assert.equal(sizeText(view({ labels: [label('A', null)], relationshipTypes: [] })), 'Counts not reported');
	assert.equal(sizeText(view({ labels: [label('A', null)], relationshipTypes: [type('R', 2)] })), 'Nodes not reported \u00b7 2 relationships', 'a line starts with a capital');
	assert.equal(sizeText(view({ evidence: 'stale', labels: [label('A', 3)], relationshipTypes: [] })), '3 nodes (per label), as of the last read', 'a stale schema: the counts of the last successful read');
	assert.equal(sizeText(view({ evidence: 'fresh', labels: [], relationshipTypes: [] })), 'Empty');
	assert.equal(sizeText(view({ evidence: 'unknown', labels: [], relationshipTypes: [] })), 'Not reported', 'an unreadable schema proves nothing');
	assert.equal(sizeText(view({ labels: [label('A', 3)], relationshipTypes: [type('R', 1)] })), '3 nodes (per label) \u00b7 1 relationship');
	const props = (...names: string[]) => names.map((name) => ({ name, types: ['string'] }));
	const schema = view({ sampled: true, labels: [{ ...label('A', 1), properties: props('name', 'age') }, { ...label('B', 1), properties: props('name') }], relationshipTypes: [{ ...type('R', 1), properties: props('since') }] });
	assert.equal(schemaSummaryText(schema), '2 labels \u00b7 1 relationship type \u00b7 3 property keys (sampled)');
	assert.equal(schemaSummaryText({ ...schema, sampled: false }), '2 labels \u00b7 1 relationship type \u00b7 3 property keys');
});

test('a card\'s address names the engine once the node answered', () => {
	assert.equal(connectionView(endpoint(), probeOf('neo4j')).address, 'graph_neo4j \u00b7 Neo4j 5.26.31 Community \u00b7 Social graph');
	assert.equal(connectionView(endpoint(), undefined).address, 'graph_neo4j \u00b7 Social graph');
});

test('the drawer leads with the summary and keeps the plumbing behind its disclosure', () => {
	const schema = view({ labels: [label('A', 3)], relationshipTypes: [type('R', 1)] });
	const { summary, plumbing } = detailSections(endpoint(), probeOf('neo4j'), schema);
	assert.deepEqual(summary.map((row) => row.label), ['Engine', 'Database', 'Size', 'Schema']);
	assert.equal(summary[1].value, 'neo4j');
	assert.deepEqual(plumbing.map((row) => row.label), ['Pipeline', 'Node', 'Run', 'Writes']);
	assert.deepEqual(detailSections(endpoint(), probeOf('age'), null).summary.map((row) => row.label), ['Engine', 'Graph'], 'no size or schema line before the schema was read');
	assert.deepEqual(detailSections(endpoint(), undefined, null).summary, [], 'nothing before the node answered');
});

test('the drawer never claims "0 labels" for a schema nobody could read', () => {
	const rows = (schema: ISchemaView) => Object.fromEntries(detailSections(endpoint(), probeOf('neo4j'), schema).summary.map((row) => [row.label, row.value]));
	const unread = 'Could not be read';
	const unreported = 'Not reported by this node';
	assert.deepEqual(rows(parseSchema(fixture('schema_v2_never_succeeded'))), { Engine: 'Neo4j 5.26.31 Community', Database: 'neo4j', Schema: unread }, 'an error');
	assert.deepEqual(rows(NO_SCHEMA), { Engine: 'Neo4j 5.26.31 Community', Database: 'neo4j', Schema: unread }, 'a failed first load');
	assert.equal(rows(view({ evidence: 'incapable', labels: [], relationshipTypes: [] })).Schema, unreported, 'an incapable node');
	assert.equal(rows(parseSchema({ labels: [], nodes: {}, relationships: [] })).Schema, unreported, 'an old node\'s empty answer');
	for (const schema of [parseSchema(fixture('schema_v2_never_succeeded')), NO_SCHEMA, parseSchema({ labels: [], nodes: {}, relationships: [] })]) {
		assert.equal(rows(schema).Size, undefined, 'and no size line');
		assert.doesNotMatch(JSON.stringify(rows(schema)), /0 labels/);
	}
	assert.equal(rows(view({ evidence: 'fresh', sampled: false, labels: [], relationshipTypes: [] })).Schema, '0 labels \u00b7 0 relationship types \u00b7 0 property keys', 'a fresh read that lists nothing is an empty graph');
	assert.equal(rows(view({ evidence: 'stale', sampled: false, labels: [label('A', 1)], relationshipTypes: [] })).Schema, '1 label \u00b7 0 relationship types \u00b7 0 property keys (as of the last read)');
	assert.equal(rows(view({ evidence: 'stale', sampled: true, labels: [label('A', 1)], relationshipTypes: [] })).Schema, '1 label \u00b7 0 relationship types \u00b7 0 property keys (sampled, as of the last read)', 'one parenthetical, not two');
	assert.match(rows(parseSchema(fixture('schema_old_node'))).Schema, /^2 labels/, 'an old node that lists something: what it lists');
});
