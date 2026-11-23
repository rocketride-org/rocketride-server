// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { publishedSourceEndpoint } from './sourceEndpoint';

test('a published webhook has a data door at its address, the host left to the dialog', () => {
	assert.deepEqual(publishedSourceEndpoint({ address: 'acme.docBrain.webhook_1', nodeId: 'webhook_1', interfaces: ['webhook'] }), {
		'url-text': 'Endpoint URL',
		'url-link': '{host}/webhook/acme.docBrain.webhook_1',
		address: 'acme.docBrain.webhook_1',
	});
});

test('a published chat or dropper source has no URL, only the front end that talks to it', () => {
	assert.deepEqual(publishedSourceEndpoint({ address: 'acme.docBrain.chat_1', nodeId: 'chat_1', interfaces: ['chat'] }), {
		'button-text': 'Open Chat',
		'open-tool': 'rocketride.chat',
		nodeId: 'chat_1',
		address: 'acme.docBrain.chat_1',
	});
	assert.equal(publishedSourceEndpoint({ address: 'acme.docBrain.drop_1', nodeId: 'drop_1', interfaces: ['dropper'] })?.['open-tool'], 'rocketride.dropper');
});

test('a source that carries neither has no endpoint to show', () => {
	assert.equal(publishedSourceEndpoint({ address: 'acme.docBrain.tools_1', nodeId: 'tools_1', interfaces: ['tools'] }), null);
	assert.equal(publishedSourceEndpoint({ address: 'acme.docBrain.src_1', nodeId: 'src_1', interfaces: [] }), null);
});
