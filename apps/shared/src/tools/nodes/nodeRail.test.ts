// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createNodeRailHost, nodeIdOfPackage, toNodeRail } from './nodeRail';
import type { INodeRailBus, WireNodeRail } from './nodeRail';

const TEAMS = [{ id: 't-1', name: 'research' }];

const RAIL: WireNodeRail = {
	versions: [
		{ version: 1, sha256: 'a', publishedBy: { display: 'Ada' }, publishedAt: 10, comment: 'first', state: 'private' },
		{ version: 2, sha256: 'b', publishedBy: { userId: 'u2' }, publishedAt: 20, state: 'failed' },
		{ version: 3, sha256: 'c', publishedBy: { display: 'Ada' }, publishedAt: 30, state: 'private' },
	],
	publishes: [
		{ audience: { type: 'user', id: 'u1' }, version: 3, state: 'enabled', updatedAt: 31 },
		{ audience: { type: 'team', id: 't-1' }, version: 1, state: 'enabled', updatedAt: 11 },
		{ audience: { type: 'team', id: 't-gone' }, version: 3, state: 'removed' },
		{ audience: { type: 'team', id: 't-off' }, version: 1, state: 'disabled' },
	],
};

test('a node rail lists versions newest first, with the rungs each is live on', () => {
	const { versions } = toNodeRail(RAIL, TEAMS);

	assert.deepEqual(
		versions.map((v) => [v.registryVersion, v.author, v.message, v.rungs, v.state, v.buildStatus]),
		[
			[3, 'Ada', undefined, ['personal'], 'private', ''],
			[2, 'u2', undefined, [], 'failed', 'failed'],
			[1, 'Ada', 'first', ['team'], 'private', ''],
		]
	);
});

test('only enabled bindings are live, and a team handle uses its name', () => {
	const { pins } = toNodeRail(RAIL, TEAMS);

	assert.deepEqual(
		pins.map((p) => [p.rung, p.handle, p.registryVersion, p.deployedAt]),
		[
			['personal', '@me', 3, 31],
			['team', '@team/research', 1, 11],
		]
	);
});

test('a team the caller no longer sees keeps its id as the handle', () => {
	const { pins } = toNodeRail({ publishes: [{ audience: { type: 'team', id: 't-9' }, version: 1, state: 'enabled' }] }, TEAMS);

	assert.equal(pins[0].handle, '@team/t-9');
});

/** A bus whose client records what it is asked. */
function fakeBus(added: { nodeId?: string } = { nodeId: 'acme.echo' }) {
	const calls: Array<[string, Record<string, unknown> | undefined]> = [];
	const uploads: Array<{ data: Uint8Array; comment?: string }> = [];
	let refreshed = 0;
	const bus: INodeRailBus = {
		getClient: () => ({
			call: async (command: string, args?: Record<string, unknown>) => {
				calls.push([command, args]);
				return RAIL;
			},
			deploy: {
				add: async (o: { data: Uint8Array; comment?: string }) => {
					uploads.push(o);
					return { artifact: { nodeId: added.nodeId, version: 4 } };
				},
			},
		}),
		getAccountInfo: () => ({ organization: { teams: TEAMS } }),
		refreshServices: async () => {
			refreshed += 1;
		},
	};
	return { bus, calls, uploads, refreshed: () => refreshed };
}

test('the host publishes and unpublishes the node, then refreshes the catalogue', async () => {
	const { bus, calls, refreshed } = fakeBus();
	const host = createNodeRailHost({ bus, nodeId: 'acme.echo', pickPackage: async () => null });

	await host.publish?.(3, '@team/research');
	await host.removePublish?.('@me');

	assert.deepEqual(calls, [
		['rrext_deploy_node', { nodeId: 'acme.echo', subcommand: 'publish', version: 3, target: '@team/research' }],
		['rrext_deploy_node', { nodeId: 'acme.echo', subcommand: 'unpublish', target: '@me' }],
	]);
	assert.equal(refreshed(), 2);
	assert.equal(host.capabilities.hasReviewLadder, false);
	assert.equal(host.submitForReview, undefined);
});

test('a deploy uploads the chosen package with its comment', async () => {
	const { bus, uploads } = fakeBus();
	const data = new Uint8Array([1, 2]);
	const host = createNodeRailHost({ bus, nodeId: 'acme.echo', pickPackage: async () => data });

	await host.deploy?.('fix the prompt');

	assert.deepEqual(uploads, [{ kind: 'node', data, comment: 'fix the prompt' }]);
});

test('a deploy with no package chosen, or of another node, says so', async () => {
	const none = createNodeRailHost({ bus: fakeBus().bus, nodeId: 'acme.echo', pickPackage: async () => null });
	await assert.rejects(() => none.deploy!(''), /No package was chosen/);

	const other = createNodeRailHost({ bus: fakeBus({ nodeId: 'acme.ping' }).bus, nodeId: 'acme.echo', pickPackage: async () => new Uint8Array([1]) });
	await assert.rejects(() => other.deploy!(''), /That package is acme\.ping, not acme\.echo/);
});

test('a workspace .rrnode names its node by its module', () => {
	assert.equal(nodeIdOfPackage('nodes/acme__echo.rrnode'), 'acme.echo');
	assert.equal(nodeIdOfPackage('nodes/acme__echo/.rrnode'), 'acme.echo');
	assert.equal(nodeIdOfPackage('nodes/acme__my_node.rrnode'), 'acme.my_node');
	assert.equal(nodeIdOfPackage('nodes/webhook.rrnode'), null);
	assert.equal(nodeIdOfPackage('nodes/__echo.rrnode'), null);
	assert.equal(nodeIdOfPackage('nodes/acme__.rrnode'), null);
});
