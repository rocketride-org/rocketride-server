// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPE PICKER LOGIC — the catalog reads, the interface, the deep link
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PIPE_PAGE_LIMIT, fetchOwnPipes, hrefWithPipeLink, interfaceNodes, looksLikeAddress, matchesTerm, pipeLinkFromSearch, rungLabel, searchStorePipes } from './pipePickerLogic';
import type { IPipeEntry, IPipePage } from './pipePickerLogic';

// ==== Helpers ================================================================

/** A pipe entry of the given rung. */
function entry(pipe: string, rung: IPipeEntry['rung'] = 'team', over: Partial<IPipeEntry> = {}): IPipeEntry {
	return { kind: 'pipe', id: pipe, pipe, name: pipe.split('.')[1] ?? pipe, rung, ...over };
}

/** A fake catalog call over fixed pages, recording the arguments it was sent. */
function fakeCall(pages: Array<IPipePage | null>): { call: (args: Record<string, unknown>) => Promise<IPipePage | null>; sent: Record<string, unknown>[] } {
	const sent: Record<string, unknown>[] = [];
	let index = 0;
	return {
		sent,
		call: async (args) => {
			sent.push(args);
			return pages[index++] ?? null;
		},
	};
}

// ==== fetchOwnPipes ==========================================================

test('the own list is one request when the first page holds everything, and never sends a search', async () => {
	const { call, sent } = fakeCall([{ apps: [entry('acme.a', 'me'), entry('acme.b')], total: 2 }]);
	const pipes = await fetchOwnPipes(call);
	assert.deepEqual(
		pipes.map((p) => p.pipe),
		['acme.a', 'acme.b']
	);
	assert.deepEqual(sent, [{ kind: 'pipe', offset: 0, limit: PIPE_PAGE_LIMIT }]);
});

test('the own list pages until the total, in server order', async () => {
	const first = Array.from({ length: PIPE_PAGE_LIMIT }, (_, i) => entry(`acme.p${i}`));
	const { call, sent } = fakeCall([
		{ apps: first, total: PIPE_PAGE_LIMIT + 1 },
		{ apps: [entry('acme.last')], total: PIPE_PAGE_LIMIT + 1 },
	]);
	const pipes = await fetchOwnPipes(call);
	assert.equal(pipes.length, PIPE_PAGE_LIMIT + 1);
	assert.equal(pipes[pipes.length - 1]!.pipe, 'acme.last');
	assert.deepEqual(
		sent.map((a) => a.offset),
		[0, PIPE_PAGE_LIMIT]
	);
});

test('a total that disagrees with the pages cannot loop, and rows that are not pipes are dropped', async () => {
	const { call, sent } = fakeCall([{ apps: [entry('acme.a'), { kind: 'app', id: 'x' } as unknown as IPipeEntry], total: 999 }]);
	const pipes = await fetchOwnPipes(call);
	assert.deepEqual(
		pipes.map((p) => p.pipe),
		['acme.a']
	);
	assert.equal(sent.length, 1);
	assert.deepEqual(await fetchOwnPipes(fakeCall([null]).call), []);
});

// ==== searchStorePipes =======================================================

test('a blank store search sends nothing: the store is searched, never listed', async () => {
	const { call, sent } = fakeCall([]);
	assert.deepEqual(await searchStorePipes(call, '   '), { entries: [], total: 0 });
	assert.equal(sent.length, 0);
});

test('a store search sends the trimmed term with its page and answers the total', async () => {
	const { call, sent } = fakeCall([{ apps: [entry('zeta.doc', 'public')], total: 41 }]);
	const page = await searchStorePipes(call, ' doc ', 20, 20);
	assert.deepEqual(sent, [{ kind: 'pipe', search: 'doc', offset: 20, limit: 20 }]);
	assert.deepEqual(page, { entries: [entry('zeta.doc', 'public')], total: 41 });
});

// ==== interfaceNodes =========================================================

test('the nodes of one interface keep the address they answered under', () => {
	const answer = {
		interfaces: {
			'acme.doc.chat_1': { source: [{ nodeId: 'chat_1', name: 'Ask' }], chat: [{ nodeId: 'chat_1', name: 'Ask' }] },
			'acme.doc.drop_1': { source: [{ nodeId: 'drop_1', name: 'drop_1' }], dropper: [{ nodeId: 'drop_1', name: 'drop_1' }] },
			'acme.doc': {
				database: [
					{ nodeId: 'pg_1', name: 'Orders' },
					{ nodeId: 'ch_1', name: '' },
				],
				llm: [{ nodeId: 'llm_1', name: 'GPT' }],
			},
		},
	};
	assert.deepEqual(interfaceNodes(answer, 'chat'), [{ address: 'acme.doc.chat_1', nodeId: 'chat_1', name: 'Ask' }]);
	assert.deepEqual(interfaceNodes(answer, 'database'), [
		{ address: 'acme.doc', nodeId: 'pg_1', name: 'Orders' },
		{ address: 'acme.doc', nodeId: 'ch_1', name: 'ch_1' },
	]);
});

test('a pipe without the interface answers no nodes; malformed entries are skipped', () => {
	assert.deepEqual(interfaceNodes({ interfaces: { 'acme.doc': { llm: [{ nodeId: 'llm_1', name: 'GPT' }] } } }, 'chat'), []);
	assert.deepEqual(interfaceNodes({ interfaces: { 'acme.doc': { chat: [null, { name: 'no id' }, { nodeId: 'c', name: 'c' }, { nodeId: 'c', name: 'c' }] } } }, 'chat'), [{ address: 'acme.doc', nodeId: 'c', name: 'c' }]);
	assert.deepEqual(interfaceNodes(undefined, 'chat'), []);
});

// ==== Display ================================================================

test('the rung reads as yours, a team, or the store', () => {
	assert.equal(rungLabel({ rung: 'me' }), 'Published to you');
	assert.equal(rungLabel({ rung: 'team', teamName: 'Research', teamId: 't-1' }), 'Team Research');
	assert.equal(rungLabel({ rung: 'team', teamId: 't-1' }), 'Team t-1');
	assert.equal(rungLabel({ rung: 'public', publisher: 'zeta' }), 'Store · zeta');
});

test('the filter matches name, address or description, case-insensitively', () => {
	const pipe = entry('acme.docBrain', 'me', { name: 'Doc Brain', description: 'Reads invoices' });
	assert.equal(matchesTerm(pipe, ''), true);
	assert.equal(matchesTerm(pipe, 'brain'), true);
	assert.equal(matchesTerm(pipe, 'ACME.'), true);
	assert.equal(matchesTerm(pipe, 'invoice'), true);
	assert.equal(matchesTerm(pipe, 'weather'), false);
});

test('an address has two or three dot-free segments', () => {
	assert.equal(looksLikeAddress(' acme.docBrain '), true);
	assert.equal(looksLikeAddress('acme.docBrain.chat_1'), true);
	assert.equal(looksLikeAddress('acme'), false);
	assert.equal(looksLikeAddress('acme.doc brain'), false);
	assert.equal(looksLikeAddress('a.b.c.d'), false);
});

// ==== The deep link ==========================================================

test('the link reads pipe= and node=, and is absent without a pipe', () => {
	assert.deepEqual(pipeLinkFromSearch('?appid=rocketride.sql&pipe=acme.doc&node=pg_1'), { pipe: 'acme.doc', node: 'pg_1' });
	assert.deepEqual(pipeLinkFromSearch('?pipe=%20acme.doc.chat_1%20'), { pipe: 'acme.doc.chat_1' });
	assert.equal(pipeLinkFromSearch('?appid=rocketride.chat'), null);
	assert.equal(pipeLinkFromSearch('?pipe=%20&node=x'), null);
});

test('writing the choice keeps the other parameters and drops a stale node', () => {
	const sql = hrefWithPipeLink('https://h/?appid=rocketride.sql', 'acme.doc', 'pg_1');
	assert.deepEqual(pipeLinkFromSearch(new URL(sql).search), { pipe: 'acme.doc', node: 'pg_1' });
	assert.equal(new URL(sql).searchParams.get('appid'), 'rocketride.sql');
	const chat = hrefWithPipeLink('https://h/?appid=rocketride.chat&pipe=old.one&node=stale', 'acme.doc.chat_1');
	assert.deepEqual(pipeLinkFromSearch(new URL(chat).search), { pipe: 'acme.doc.chat_1' });
});
