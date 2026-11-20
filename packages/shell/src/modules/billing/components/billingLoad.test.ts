// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationUsage } from 'rocketride';
import { createLoadGenerations, PUBLICATION_LOAD_FAILED, settlePublicationUsage } from './billingLoad';

const row: PublicationUsage = { pipe: 'acme.docBrain', rung: 'team', team: 'team-prod', teamName: 'Production', version: 4, requestCount: 3, credits: { tokens: 10 } };

test('a single load stays current from start to finish', () => {
	const loads = createLoadGenerations();
	const only = loads.begin();

	assert.equal(loads.isCurrent(only), true);
});

test('a later load retires an earlier one, whichever finishes first', () => {
	const loads = createLoadGenerations();
	const november = loads.begin();
	const december = loads.begin();

	// November finishing after December must not commit, nor clear the loading flags
	assert.equal(loads.isCurrent(november), false);
	assert.equal(loads.isCurrent(december), true);
});

test('a load begun with nothing to fetch still retires the loads before it', () => {
	const loads = createLoadGenerations();
	const inFlight = loads.begin();
	loads.begin();

	assert.equal(loads.isCurrent(inFlight), false);
});

test('two loaders count apart', () => {
	const first = createLoadGenerations();
	const second = createLoadGenerations();
	const a = first.begin();
	second.begin();
	second.begin();

	assert.equal(first.isCurrent(a), true);
});

test('a successful read carries its rows and no error', async () => {
	assert.deepEqual(await settlePublicationUsage(Promise.resolve([row])), { usage: [row], error: null });
});

test('a successful empty month is [] with no error, unlike a failure', async () => {
	assert.deepEqual(await settlePublicationUsage(Promise.resolve([])), { usage: [], error: null });
});

test('a failed read is an error with no rows', async () => {
	assert.deepEqual(await settlePublicationUsage(Promise.reject(new Error('Admin role required for this operation'))), { usage: [], error: 'Admin role required for this operation' });
});

test('a failure without a message gets the generic one', async () => {
	assert.deepEqual(await settlePublicationUsage(Promise.reject('boom')), { usage: [], error: PUBLICATION_LOAD_FAILED });
	assert.deepEqual(await settlePublicationUsage(Promise.reject(new Error(''))), { usage: [], error: PUBLICATION_LOAD_FAILED });
});
