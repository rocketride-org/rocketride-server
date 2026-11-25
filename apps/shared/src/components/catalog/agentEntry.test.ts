// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_LABEL, entryLabel, isAgentEntry, isAnonymousEntry, launchEntry, signedOutEntries, type CatalogEntry, type SwitchAppRequest } from './agentEntry';

/** A ConnectionManager stand-in that records each shell:switchApp payload. */
function recorder() {
	const calls: SwitchAppRequest[] = [];
	return { calls, emit: (_event: 'shell:switchApp', payload: SwitchAppRequest) => { calls.push(payload); } };
}

/** The shell's launch rule as the barrel serves it (an agent opens its host bound to its address). */
const shell = {
	switchAppRequestOf: (entry: CatalogEntry): SwitchAppRequest =>
		entry.kind === 'pipe' && entry.pipe && entry.hostAppId
			? { appId: entry.hostAppId, params: { pipe: entry.pipe } }
			: { appId: entry.id },
};

const AGENT: CatalogEntry = {
	id: 'acme.supportBot',
	kind: 'pipe',
	pipe: 'acme.supportBot',
	hostAppId: 'rocketride.playground',
	categories: ['pipeline'],
};

test('an agent row reads "Agent" whatever its categories say; an app row its first category', () => {
	assert.equal(AGENT_LABEL, 'Agent');
	assert.equal(entryLabel(AGENT), 'Agent');
	assert.equal(entryLabel({ id: 'rocketride.sql', categories: ['ai', 'chat'] }), 'AI');
	assert.equal(entryLabel({ id: 'rocketride.sql' }), null);
	assert.equal(isAgentEntry(AGENT), true);
	assert.equal(isAgentEntry({ kind: 'app' }), false);
});

test('opening goes through the shell rule: an agent opens its host bound to its address, an app its id', () => {
	const cm = recorder();
	launchEntry(cm, shell, AGENT);
	launchEntry(cm, shell, { id: 'rocketride.sql' });
	assert.deepEqual(cm.calls, [
		{ appId: 'rocketride.playground', params: { pipe: 'acme.supportBot' } },
		{ appId: 'rocketride.sql' },
	]);
});

test('a host shell without the rule opens every entry by its id', () => {
	const cm = recorder();
	launchEntry(cm, {}, AGENT);
	assert.deepEqual(cm.calls, [{ appId: 'acme.supportBot' }]);
});

test('a signed-out viewer keeps the public apps without their enrichment and no agent', () => {
	const app = { id: 'rocketride.sql', categories: ['ai'], onDesktop: true, appStatus: 'subscribed' };
	const kept = signedOutEntries([app, { ...AGENT, onDesktop: true, appStatus: 'free' }]);
	assert.deepEqual(kept, [{ id: 'rocketride.sql', categories: ['ai'], onDesktop: false, appStatus: undefined }]);
	// The input is left as it was
	assert.equal(app.onDesktop, true);
});

test('a signed-out viewer keeps only what an anonymous fetch returns', () => {
	const open = { id: 'rocketride.sql', public: true, requiredPermissions: [] };
	const plain = { id: 'rocketride.hello' };
	const teamOnly = { id: 'acme.internal', public: false };
	const gated = { id: 'rocketride.admin', public: true, requiredPermissions: ['sys.app'] };
	assert.deepEqual([open, plain, teamOnly, gated, AGENT].map(isAnonymousEntry), [true, true, false, false, false]);
	assert.deepEqual(signedOutEntries([open, plain, teamOnly, gated, AGENT]).map((entry) => entry.id), ['rocketride.sql', 'rocketride.hello']);
});
