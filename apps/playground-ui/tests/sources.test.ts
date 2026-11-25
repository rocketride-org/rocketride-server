// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Sources, their kind and what they take (core/sources.ts), over the
 * webhook node's real service declarations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSources, otherWaysIn, pickSource, serviceFor, takesFile, takesHint } from '../src/core/sources';
import type { InterfaceMap, ServiceLike } from '../src/core/sources';

// The declarations of nodes/src/nodes/webhook/services.*.json, telegram and S3.
const SERVICES: Record<string, ServiceLike> = {
	chat: { title: 'Chat', classType: ['source', 'chat'], lanes: { _source: ['questions'] } },
	dropper: { title: 'Dropper', classType: ['source', 'dropper'], lanes: { _source: ['tags'] } },
	webhook: { title: 'Webhook', classType: ['source', 'webhook'], lanes: { _source: ['tags', 'text', 'json', 'audio', 'video', 'image', 'questions'] } },
	tools: { title: 'Tools', classType: ['source', 'tools'], lanes: { _source: [] } },
	telegram: { title: 'Telegram Bot', classType: ['source'], lanes: { _source: ['text', 'image', 'audio', 'video', 'tags'] } },
	discord: { title: 'Discord Bot', classType: ['source'], lanes: { _source: ['text', 'image', 'audio', 'video', 'tags'] } },
	aws: { title: 'AWS S3', classType: ['source', 'objstore'], lanes: { _source: ['tags'] } },
	images: { title: 'Image source', classType: ['source', 'imagedrop'], lanes: { _source: ['image'] } },
};

const map = (entries: Record<string, string[]>): InterfaceMap => Object.fromEntries(Object.entries(entries).map(([address, classes]) => [address, Object.fromEntries(classes.map((c) => [c, [{ nodeId: address.split('.').pop()!, name: '' }]]))]));

test('describeSources: request kinds come from the webhook services; the rest work on their own', () => {
	const sources = describeSources(map({ 'acme.p.chat_1': ['source', 'chat'], 'acme.p.s3_1': ['source', 'objstore'], 'acme.p.tg': ['source'], 'acme.p': ['llm'] }), SERVICES);
	assert.deepEqual(
		sources.map((s) => [s.address, s.kind, s.title]),
		[
			['acme.p.chat_1', 'request', 'Chat'],
			['acme.p.s3_1', 'onItsOwn', 'AWS S3'],
			['acme.p.tg', 'onItsOwn', 'tg'],
		]
	);
});

test('describeSources: typed input and file lanes follow the declared lanes', () => {
	const [chat, dropper, webhook, tools] = describeSources(map({ 'a.p.c': ['source', 'chat'], 'a.p.d': ['source', 'dropper'], 'a.p.w': ['source', 'webhook'], 'a.p.t': ['source', 'tools'] }), SERVICES);
	assert.equal(chat.typed, 'questions');
	assert.deepEqual(chat.fileLanes, []);
	assert.equal(dropper.typed, null);
	assert.deepEqual(dropper.fileLanes, ['tags']);
	assert.equal(webhook.typed, 'questions');
	assert.deepEqual(webhook.fileLanes, ['tags', 'image', 'audio', 'video']);
	assert.equal(tools.entry, 'tool');
});

test('serviceFor: a classType set shared by several services names none', () => {
	assert.equal(serviceFor(['source'], SERVICES), undefined);
	assert.equal(serviceFor(['chat', 'source'], SERVICES)?.title, 'Chat');
});

test('pickSource: the named address, then the default source, then the first data request source', () => {
	const sources = describeSources(map({ 'a.p.s3': ['source', 'objstore'], 'a.p.ask': ['source', 'chat'], 'a.p.drop': ['source', 'dropper'] }), SERVICES);
	assert.equal(pickSource(sources, 'a.p.drop')?.address, 'a.p.drop');
	assert.equal(pickSource(sources, 'a.p', 's3')?.address, 'a.p.s3');
	assert.equal(pickSource(sources, 'a.p')?.address, 'a.p.ask');
	assert.deepEqual(
		otherWaysIn(sources, sources[0]).map((s) => s.address),
		['a.p.ask', 'a.p.drop']
	);
});

test('takesFile and takesHint: tags takes any file; a media lane only its own type', () => {
	const [dropper, images, webhook] = describeSources(map({ 'a.p.d': ['source', 'dropper'], 'a.p.i': ['source', 'imagedrop'], 'a.p.w': ['source', 'webhook'] }), SERVICES);
	assert.equal(takesFile(dropper, 'application/pdf'), true);
	assert.equal(takesFile(images, 'image/png'), true);
	assert.equal(takesFile(images, 'application/pdf'), false);
	assert.equal(takesHint(dropper), 'Takes any file. You can drop several at once.');
	assert.equal(takesHint(images), 'Takes images. You can drop several at once.');
	assert.equal(takesHint(webhook), 'Takes questions and any file.');
});
