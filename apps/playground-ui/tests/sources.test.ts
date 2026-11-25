// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Sources and what they take (core/sources.ts), over the contract read's
 * `sources` as the server describes the webhook, telegram, filesys and S3
 * nodes from their service declarations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSources, otherWaysIn, pickSource, takesFile, takesHint } from '../src/core/sources';
import type { SourceLike, SourceMap } from '../src/core/sources';

// What the server says about each node, from nodes/src/nodes/*/services*.json.
const SOURCES: Record<string, Omit<SourceLike, 'nodeId' | 'name'>> = {
	chat: { title: 'Chat', kind: 'request', entry: 'data', lanes: ['questions'] },
	dropper: { title: 'Dropper', kind: 'request', entry: 'data', lanes: ['tags'] },
	webhook: { title: 'Webhook', kind: 'request', entry: 'data', lanes: ['tags', 'text', 'json', 'audio', 'video', 'image', 'questions'] },
	tools: { title: 'Tools', kind: 'request', entry: 'tool', lanes: [] },
	telegram: { title: 'Telegram Bot', kind: 'listener', entry: 'data', lanes: ['text', 'image', 'audio', 'video', 'tags'] },
	filesys: { title: 'Local File System', kind: 'scan', entry: 'data', lanes: ['tags'] },
	aws: { title: 'AWS S3', kind: 'scan', entry: 'data', lanes: ['tags'] },
	images: { title: 'Image source', kind: 'request', entry: 'data', lanes: ['image'] },
};

/** A `sources` answer: each address's last segment is its node id, described as the named service. */
const sourcesOf = (entries: Record<string, keyof typeof SOURCES>): SourceMap => Object.fromEntries(Object.entries(entries).map(([address, service]) => [address, { nodeId: address.split('.').pop()!, name: '', ...SOURCES[service] }]));

test('describeSources: one source per address, in the order the server lists them, with its kind and title', () => {
	const sources = describeSources(sourcesOf({ 'acme.p.chat_1': 'chat', 'acme.p.s3_1': 'aws', 'acme.p.tg': 'telegram' }));
	assert.deepEqual(
		sources.map((s) => [s.address, s.kind, s.title]),
		[
			['acme.p.chat_1', 'request', 'Chat'],
			['acme.p.s3_1', 'scan', 'AWS S3'],
			['acme.p.tg', 'listener', 'Telegram Bot'],
		]
	);
});

test('describeSources: the name falls back to the node id; the title to the name', () => {
	const [source] = describeSources({ 'a.p.mine': { nodeId: 'mine', name: '', title: '', kind: 'scan', entry: 'data', lanes: [] } });
	assert.equal(source.name, 'mine');
	assert.equal(source.title, 'mine');
});

test('describeSources: no sources from a server that sends none, and malformed entries are skipped', () => {
	assert.deepEqual(describeSources(undefined), []);
	assert.deepEqual(describeSources({ 'a.p.x': null, 'a.p.y': undefined }), []);
});

test('describeSources: typed input and file lanes follow the declared lanes', () => {
	const [chat, dropper, webhook, tools] = describeSources(sourcesOf({ 'a.p.c': 'chat', 'a.p.d': 'dropper', 'a.p.w': 'webhook', 'a.p.t': 'tools' }));
	assert.equal(chat.typed, 'questions');
	assert.deepEqual(chat.fileLanes, []);
	assert.equal(dropper.typed, null);
	assert.deepEqual(dropper.fileLanes, ['tags']);
	assert.equal(webhook.typed, 'questions');
	assert.deepEqual(webhook.fileLanes, ['tags', 'image', 'audio', 'video']);
	assert.equal(tools.entry, 'tool');
});

test('pickSource: the named address, then the default source, then the first data request source', () => {
	const sources = describeSources(sourcesOf({ 'a.p.s3': 'aws', 'a.p.ask': 'chat', 'a.p.drop': 'dropper' }));
	assert.equal(pickSource(sources, 'a.p.drop')?.address, 'a.p.drop');
	assert.equal(pickSource(sources, 'a.p', 's3')?.address, 'a.p.s3');
	assert.equal(pickSource(sources, 'a.p')?.address, 'a.p.ask');
	assert.deepEqual(
		otherWaysIn(sources, sources[0]).map((s) => s.address),
		['a.p.ask', 'a.p.drop']
	);
});

test('otherWaysIn: listeners, scans and tool sources are never offered', () => {
	const sources = describeSources(sourcesOf({ 'a.p.ask': 'chat', 'a.p.tg': 'telegram', 'a.p.fs': 'filesys', 'a.p.t': 'tools' }));
	assert.deepEqual(otherWaysIn(sources, sources[1]).map((s) => s.address), ['a.p.ask']);
});

test('takesFile and takesHint: tags takes any file; a media lane only its own type', () => {
	const [dropper, images, webhook] = describeSources(sourcesOf({ 'a.p.d': 'dropper', 'a.p.i': 'images', 'a.p.w': 'webhook' }));
	assert.equal(takesFile(dropper, 'application/pdf'), true);
	assert.equal(takesFile(images, 'image/png'), true);
	assert.equal(takesFile(images, 'application/pdf'), false);
	assert.equal(takesHint(dropper), 'Takes any file. You can drop several at once.');
	assert.equal(takesHint(images), 'Takes images. You can drop several at once.');
	assert.equal(takesHint(webhook), 'Takes questions and any file.');
});
