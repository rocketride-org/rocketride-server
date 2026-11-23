// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentApi } from './agentApi';

/** An interfaces() answer: a chat source, a plain source, a database tool, a tool and a model. */
const ANSWER = {
	address: 'acme.docBrain',
	rung: 'org',
	version: 3,
	interfaces: {
		'acme.docBrain.chat_1': { source: [{ nodeId: 'chat_1', name: 'Chat' }], chat: [{ nodeId: 'chat_1', name: 'Chat' }] },
		'acme.docBrain': {
			database: [{ nodeId: 'db_1', name: 'Orders' }],
			tool: [{ nodeId: 'db_1', name: 'Orders' }, { nodeId: 'http_1', name: 'http_1' }],
			llm: [{ nodeId: 'llm_1', name: 'Model' }],
		},
		'acme.docBrain.drop_1': { source: [{ nodeId: 'drop_1', name: 'drop_1' }] },
	},
};

test('an agent API is one row per node: the sources under their own addresses, the rest under the agent', () => {
	assert.deepEqual(agentApi(ANSWER, 'acme.docBrain'), {
		address: 'acme.docBrain',
		// source is the mark, never an interface of its own; a plain source carries none
		sources: [
			{ address: 'acme.docBrain.chat_1', nodeId: 'chat_1', name: 'Chat', interfaces: ['chat'] },
			{ address: 'acme.docBrain.drop_1', nodeId: 'drop_1', name: 'drop_1', interfaces: [] },
		],
		// A node listed under two classTypes is one row carrying both
		nodes: [
			{ address: 'acme.docBrain', nodeId: 'db_1', name: 'Orders', interfaces: ['database', 'tool'] },
			{ address: 'acme.docBrain', nodeId: 'http_1', name: 'http_1', interfaces: ['tool'] },
			{ address: 'acme.docBrain', nodeId: 'llm_1', name: 'Model', interfaces: ['llm'] },
		],
		parameters: [],
	});
});

test('an answer that lists no node is no API', () => {
	assert.equal(agentApi(null, 'acme.docBrain'), null);
	assert.equal(agentApi(undefined, 'acme.docBrain'), null);
	assert.equal(agentApi({}, 'acme.docBrain'), null);
	assert.equal(agentApi({ interfaces: null }, 'acme.docBrain'), null);
	assert.equal(agentApi({ interfaces: {} }, 'acme.docBrain'), null);
	assert.equal(agentApi({ interfaces: { 'acme.docBrain': null } }, 'acme.docBrain'), null);
	assert.equal(agentApi({ interfaces: { 'acme.docBrain': { tool: [] } } }, 'acme.docBrain'), null);
	// A node without an id cannot be named in a call: it is no row
	assert.equal(agentApi({ interfaces: { 'acme.docBrain': { tool: [null, { name: 'Nameless' }, { nodeId: '' }] } } }, 'acme.docBrain'), null);
});

test('a node without a name shows its id, and the asked address stands in for one the answer does not name', () => {
	assert.deepEqual(agentApi({ interfaces: { 'acme.docBrain': { tool: [{ nodeId: 'http_1' }, { nodeId: 'http_1', name: 'Later' }] } } }, 'acme.docBrain'), {
		address: 'acme.docBrain',
		sources: [],
		nodes: [{ address: 'acme.docBrain', nodeId: 'http_1', name: 'http_1', interfaces: ['tool'] }],
		parameters: [],
	});
});

test('the parameters are told by public name: the type with its bounds or values, the description, the default as text', () => {
	const api = agentApi(
		{
			interfaces: {},
			parameters: [
				{ name: 'start_time', default: 60, type: 'number', title: 'Start time', minimum: 0 },
				{ name: 'max_edge', default: 1024, type: 'integer', description: 'Largest input edge', title: 'Max edge', minimum: 256, maximum: 4096 },
				{ name: 'redactionStyle', default: 'mask', type: 'string', enum: ['mask', 'token'] },
				{ name: 'strict', default: false, type: 'boolean' },
				{ name: 'note', default: null },
				{ default: 1 },
				null,
			],
		},
		'acme.docBrain'
	);
	// An agent with parameters and no listed node still has an API to show
	assert.deepEqual(api, {
		address: 'acme.docBrain',
		sources: [],
		nodes: [],
		parameters: [
			{ name: 'start_time', type: 'number ≥ 0', description: 'Start time', default: '60', example: 60 },
			{ name: 'max_edge', type: 'int 256–4096', description: 'Largest input edge', default: '1024', example: 1024 },
			{ name: 'redactionStyle', type: 'mask | token', description: '', default: 'mask', example: 'mask' },
			{ name: 'strict', type: 'bool', description: '', default: 'false', example: false },
			{ name: 'note', type: 'value', description: '', default: '', example: 'value' },
		],
	});
});
