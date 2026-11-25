// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// OPEN-TOOL NOTE — the rendering decision, pure (plan 3.6)
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { actionButtons, openToolDocKey, openToolLabel, openToolNotes, openToolNotesFor, openToolTitle, parseToolDocKey, sourceEndpointNote } from './openTool';

// ==== The note walk ==========================================================

test('a filled open-tool note is a button bound to the address and node', () => {
	const notes = [{ 'button-text': 'Open in Playground', 'open-tool': 'rocketride.playground', nodeId: 'chat_1', address: 'acme.docBrain.chat_1', 'url-text': 'Chat interface URL', 'url-link': 'http://h/chat/docBrain/chat_1' }];
	assert.deepEqual(openToolNotes(notes), [{ appId: 'rocketride.playground', nodeId: 'chat_1', address: 'acme.docBrain.chat_1', label: 'Open in Playground' }]);
});

test('a note without open-tool is not a button: the webhook endpoint info, free text, numbers', () => {
	const notes = [{ 'url-text': 'Endpoint URL', 'url-link': 'http://h/webhook/acme.x.w', address: 'acme.x.w', lanes: ['json'] }, 'send to acme.x.w', 42, null];
	assert.deepEqual(openToolNotes(notes), []);
	assert.deepEqual(openToolNotes(undefined), []);
	assert.deepEqual(openToolNotes([]), []);
});

test('a note the server did not fill is not a button: a placeholder cannot bind a document', () => {
	assert.deepEqual(openToolNotes([{ 'open-tool': 'rocketride.playground', nodeId: '{source}', address: 'acme.x.chat_1' }]), []);
	assert.deepEqual(openToolNotes([{ 'open-tool': 'rocketride.playground', nodeId: 'chat_1', address: '{address}' }]), []);
	assert.deepEqual(openToolNotes([{ 'open-tool': 'rocketride.playground', nodeId: 'chat_1' }]), []);
	assert.deepEqual(openToolNotes([{ 'open-tool': '', nodeId: 'chat_1', address: 'acme.x.chat_1' }]), []);
});

test('several notes yield several buttons, in list order, each with its own node', () => {
	const notes = [
		{ 'open-tool': 'rocketride.playground', nodeId: 'dropper_1', address: 'acme.x.dropper_1', 'button-text': 'Open in Playground' },
		{ 'open-tool': 'rocketride.sql', nodeId: 'postgres_1', address: 'acme.x.dropper_1' },
	];
	assert.deepEqual(
		openToolNotes(notes).map((n) => [n.nodeId, n.label]),
		[
			['dropper_1', 'Open in Playground'],
			['postgres_1', 'Explore'],
		]
	);
});

// ==== Non-source nodes: the button found across the status map ===============

test('a non-source node finds its button in the status of the source whose engine runs it', () => {
	const statuses = {
		chat_1: { notes: [{ 'open-tool': 'rocketride.playground', nodeId: 'chat_1', address: 'acme.x.chat_1', 'button-text': 'Open in Playground' }, { 'open-tool': 'rocketride.sql', nodeId: 'postgres_1', address: 'acme.x.chat_1' }] },
		dropper_1: { notes: [{ 'open-tool': 'rocketride.sql', nodeId: 'postgres_1', address: 'acme.x.dropper_1' }] },
		idle_1: undefined,
	};
	assert.deepEqual(
		openToolNotesFor(statuses, 'postgres_1').map((n) => [n.address, n.label]),
		[
			['acme.x.chat_1', 'Explore'],
			['acme.x.dropper_1', 'Explore'],
		]
	);
	// The source node sees only its own note, not the database's
	assert.deepEqual(openToolNotesFor(statuses, 'chat_1').map((n) => n.label), ['Open in Playground']);
	// A node nobody names has no button; no map, no button
	assert.deepEqual(openToolNotesFor(statuses, 'llm_1'), []);
	assert.deepEqual(openToolNotesFor(undefined, 'postgres_1'), []);
});

test('the same button reported by two sources of one engine is shown once', () => {
	const note = { 'open-tool': 'rocketride.sql', nodeId: 'postgres_1', address: 'acme.x.chat_1' };
	assert.equal(openToolNotesFor({ a: { notes: [note] }, b: { notes: [note] } }, 'postgres_1').length, 1);
});

// ==== The source's endpoint note =============================================

const WEBHOOK = { 'url-text': 'Endpoint URL', 'url-link': 'http://h/webhook/acme.x.webhook_1', address: 'acme.x.webhook_1', lanes: ['json'] };
const CHAT = { 'button-text': 'Open in Playground', 'open-tool': 'rocketride.playground', nodeId: 'chat_1', address: 'acme.x.chat_1' };
const SQL = { 'button-text': 'Explore', 'open-tool': 'rocketride.sql', nodeId: 'postgres_1', address: 'acme.x.webhook_1' };

test('the webhook door is the endpoint even when a database note was merged in front of it', () => {
	assert.equal(sourceEndpointNote([SQL, WEBHOOK], 'webhook_1'), WEBHOOK);
	assert.equal(sourceEndpointNote([WEBHOOK, SQL], 'webhook_1'), WEBHOOK);
	// With no source id the door still wins: a door is always the source's
	assert.equal(sourceEndpointNote([SQL, WEBHOOK]), WEBHOOK);
});

test('a URL-less chat source is its own endpoint; the database note beside it never is', () => {
	const sql = { ...SQL, address: 'acme.x.chat_1' };
	assert.equal(sourceEndpointNote([sql, CHAT], 'chat_1'), CHAT);
	assert.equal(sourceEndpointNote([CHAT, sql], 'chat_1'), CHAT);
	// Only the database note in the list: no endpoint for this source
	assert.equal(sourceEndpointNote([sql], 'chat_1'), null);
	// No source id: the source is the node the address names last
	assert.equal(sourceEndpointNote([sql, CHAT]), CHAT);
	assert.equal(sourceEndpointNote([sql]), null);
});

test('no notes, no endpoint-shaped note, no endpoint', () => {
	assert.equal(sourceEndpointNote(undefined, 'chat_1'), null);
	assert.equal(sourceEndpointNote([], 'chat_1'), null);
	assert.equal(sourceEndpointNote(['free text', 42, null, { nodeId: 'chat_1' }], 'chat_1'), null);
});

// ==== The actions strip ======================================================

const CHAT_TOOL = { appId: 'rocketride.playground', nodeId: 'chat_1', address: 'acme.x.chat_1', label: 'Open in Playground' };
const SQL_TOOL = { appId: 'rocketride.sql', nodeId: 'postgres_1', address: 'acme.x.chat_1', label: 'Explore' };

test('the strip draws one button per tool, then Endpoint Info, all live', () => {
	assert.deepEqual(
		actionButtons([CHAT_TOOL, SQL_TOOL], true, false).map((b) => [b.kind, b.label, b.disabled]),
		[
			['tool', 'Open in Playground', false],
			['tool', 'Explore', false],
			['endpoint', 'Endpoint Info', false],
		]
	);
	assert.deepEqual(actionButtons([], false, false), []);
	assert.equal(actionButtons([], true, false).length, 1);
	assert.equal(actionButtons([SQL_TOOL], true, false)[0].tool, SQL_TOOL);
});

test('during a replay every button of the strip is disabled, the endpoint one included', () => {
	const buttons = actionButtons([CHAT_TOOL, SQL_TOOL], true, true);
	assert.equal(buttons.length, 3);
	assert.ok(buttons.every((b) => b.disabled));
	// A strip with only the endpoint button follows the same rule
	assert.deepEqual(actionButtons([], true, true).map((b) => b.disabled), [true]);
});

// ==== Labels =================================================================

test('the label is the note text, else the app word, else Open', () => {
	assert.equal(openToolLabel('rocketride.playground'), 'Open in Playground');
	assert.equal(openToolLabel('rocketride.sql'), 'Explore');
	assert.equal(openToolLabel('rocketride.sql', 'Query'), 'Query');
	assert.equal(openToolLabel('acme.vectors'), 'Open');
});

// ==== Document identity ======================================================

test('the document key is the address when the node is its source, else address/nodeId', () => {
	// A source binds by its address alone: the Playground's connection is that address
	assert.equal(openToolDocKey('acme.docBrain.chat_1', 'chat_1'), 'acme.docBrain.chat_1');
	assert.equal(`tool:rocketride.playground/${openToolDocKey('acme.docBrain.chat_1', 'chat_1')}`, 'tool:rocketride.playground/acme.docBrain.chat_1');
	// Any other node rides beside the address
	assert.equal(openToolDocKey('acme.docBrain.chat_1', 'postgres_1'), 'acme.docBrain.chat_1/postgres_1');
	assert.equal(`tool:rocketride.sql/${openToolDocKey('acme.docBrain.chat_1', 'postgres_1')}`, 'tool:rocketride.sql/acme.docBrain.chat_1/postgres_1');
	// A node whose id only ends the same way is not the source
	assert.equal(openToolDocKey('acme.docBrain.my_chat_1', 'chat_1'), 'acme.docBrain.my_chat_1/chat_1');
});

test('parseToolDocKey is the inverse of openToolDocKey, and a bare address still parses', () => {
	assert.deepEqual(parseToolDocKey(openToolDocKey('acme.docBrain.chat_1', 'chat_1')), { address: 'acme.docBrain.chat_1' });
	assert.deepEqual(parseToolDocKey(openToolDocKey('acme.docBrain.chat_1', 'postgres_1')), { address: 'acme.docBrain.chat_1', nodeId: 'postgres_1' });
	assert.deepEqual(parseToolDocKey('acme.docBrain/postgres_1'), { address: 'acme.docBrain', nodeId: 'postgres_1' });
	assert.deepEqual(parseToolDocKey('acme.docBrain.chat_1'), { address: 'acme.docBrain.chat_1' });
	assert.deepEqual(parseToolDocKey('acme.docBrain'), { address: 'acme.docBrain' });
});

test('a key that is not address-shaped is not a tool key: saved-connection ids, editor keys, junk', () => {
	assert.equal(parseToolDocKey('3f2a9c1e-5b7d-4e8a-9c0b-1d2e3f4a5b6c'), null);
	assert.equal(parseToolDocKey('edit:*new*'), null);
	assert.equal(parseToolDocKey('acme'), null);
	assert.equal(parseToolDocKey('acme.a.b.c'), null);
	assert.equal(parseToolDocKey('acme.docBrain/'), null);
	assert.equal(parseToolDocKey('acme.docBrain/a/b'), null);
	assert.equal(parseToolDocKey(''), null);
});

test('the title is the address when the node is its source, else address and node', () => {
	assert.equal(openToolTitle('acme.docBrain.chat_1', 'chat_1'), 'acme.docBrain.chat_1');
	assert.equal(openToolTitle('acme.docBrain.dropper_1', 'postgres_1'), 'acme.docBrain.dropper_1 · postgres_1');
});
