// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * The store-review rules both DEPLOY screens draw their version cards and
 * the Publish dialog's store row from (plan 10.1): which verbs a card offers
 * by review state, and when the store opens.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newestSubmittableOf, storeOpenFor, storeTargetOf, versionCardActionsOf } from './reviewRules';
import type { IVersionCardAbilities } from './reviewRules';

/** A host that can do everything. */
const ALL: IVersionCardAbilities = { publish: true, submit: true, withdraw: true };

describe('newestSubmittableOf', () => {
	it('is the newest version that did not fail', () => {
		assert.equal(
			newestSubmittableOf([
				{ version: 5, state: 'failed' },
				{ version: 4, state: 'private' },
				{ version: 3, state: 'ready' },
			]),
			4
		);
	});

	it('counts a version whose state is unknown, and is 0 when nothing qualifies', () => {
		assert.equal(newestSubmittableOf([{ version: 2 }, { version: 1, state: 'private' }]), 2);
		assert.equal(newestSubmittableOf([{ version: 1, state: 'failed' }]), 0);
		assert.equal(newestSubmittableOf([]), 0);
	});
});

describe('versionCardActionsOf', () => {
	it('offers Publish and Submit on the newest draft', () => {
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'private', servable: true }, 4, ALL), { publish: true, submit: true, withdraw: false });
	});

	it('offers no Submit on an older draft: review is latest-only', () => {
		assert.deepEqual(versionCardActionsOf({ version: 3, state: 'private', servable: true }, 4, ALL), { publish: true, submit: false, withdraw: false });
	});

	it('offers Withdraw on a version in review, and still Publish (internal audiences need no review)', () => {
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'submit', servable: true }, 4, ALL), { publish: true, submit: false, withdraw: true });
	});

	it('offers only Publish on a ready or rejected version', () => {
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'ready', servable: true }, 4, ALL), { publish: true, submit: false, withdraw: false });
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'rejected', servable: true }, 4, ALL), { publish: true, submit: false, withdraw: false });
	});

	it('offers nothing on a failed version', () => {
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'failed', servable: true }, 3, ALL), { publish: false, submit: false, withdraw: false });
	});

	it('offers neither Publish nor Submit while the bytes cannot serve, but a review can still be withdrawn', () => {
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'private', servable: false }, 4, ALL), { publish: false, submit: false, withdraw: false });
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'submit', servable: false }, 4, ALL), { publish: false, submit: false, withdraw: true });
	});

	it('offers Publish but no review verb when the state is unknown', () => {
		assert.deepEqual(versionCardActionsOf({ version: 4, servable: true }, 4, ALL), { publish: true, submit: false, withdraw: false });
	});

	it('never offers a verb the host lacks', () => {
		const none: IVersionCardAbilities = { publish: false, submit: false, withdraw: false };
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'private', servable: true }, 4, none), { publish: false, submit: false, withdraw: false });
		assert.deepEqual(versionCardActionsOf({ version: 4, state: 'submit', servable: true }, 4, none), { publish: false, submit: false, withdraw: false });
	});
});

describe('storeOpenFor', () => {
	it('opens only on an approved version where the server reviews', () => {
		assert.equal(storeOpenFor('ready', true), true);
		for (const state of ['private', 'submit', 'rejected', 'failed', undefined]) assert.equal(storeOpenFor(state, true), false, String(state));
	});

	it('opens on any version that did not fail where the server does not review', () => {
		for (const state of ['private', 'submit', 'ready', 'rejected', undefined]) assert.equal(storeOpenFor(state, false), true, String(state));
		assert.equal(storeOpenFor('failed', false), false);
	});
});

describe('storeTargetOf', () => {
	it('is an open row saying what the store serves now', () => {
		assert.deepEqual(storeTargetOf({ label: 'Public: the store', state: 'ready', needsApproval: true, note: 'not published' }), { id: '@public', label: 'Public: the store', note: 'not published' });
	});

	it('is a visible, closed row with the reason before approval', () => {
		const row = storeTargetOf({ label: 'Public: the store', state: 'submit', needsApproval: true, note: 'not published' });
		assert.equal(row.id, '@public');
		assert.equal(row.disabled, true);
		assert.equal(row.note, 'needs review approval');
		assert.match(row.disabledTitle ?? '', /approved \('ready'\) version/);
	});
});
