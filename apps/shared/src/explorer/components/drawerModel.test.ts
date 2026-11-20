// =============================================================================
// MIT License
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

// =============================================================================
// EXPLORER — endpoint drawer model (selection and probe lifecycle)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawerModel } from './drawerModel';

/** A probe result as the tests write it. */
interface IProbe {
	/** What the probe learned. */
	database: string;
}

/**
 * An endpoint list with these keys.
 *
 * @param keys - The endpoint keys, in list order.
 * @returns The endpoints.
 */
function listed(...keys: string[]): { key: string }[] {
	return keys.map((key) => ({ key }));
}

describe('createDrawerModel: selection', () => {
	it('starts with nothing picked and nothing probed', () => {
		const model = createDrawerModel<IProbe>();
		assert.deepEqual(model.get(), { selectedKey: null, status: 'idle', probe: null });
	});

	it('seeds the selection and picks another one', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		assert.equal(model.get().selectedKey, 'a');
		model.select('b');
		assert.deepEqual(model.get(), { selectedKey: 'b', status: 'idle', probe: null });
	});

	it('fills the first endpoint when an open drawer has nothing picked and the list arrives', () => {
		const model = createDrawerModel<IProbe>();
		model.seed(null);
		model.sync(listed(), true);
		assert.equal(model.get().selectedKey, null);
		model.sync(listed('a', 'b'), true);
		assert.equal(model.get().selectedKey, 'a');
	});

	it('does not fill while the drawer is closed', () => {
		const model = createDrawerModel<IProbe>();
		model.sync(listed('a'), false);
		assert.equal(model.get().selectedKey, null);
	});

	it('keeps a live selection, and its probe result, through a refresh that still lists it', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('b');
		const ticket = model.startProbe();
		model.finishProbe(ticket, { database: 'orders' });
		const before = model.get();
		let calls = 0;
		model.subscribe(() => {
			calls += 1;
		});

		// A background refresh: the endpoint is still listed (a vanished one is
		// kept as `stopped`), maybe in a different place.
		model.sync(listed('a', 'b', 'c'), true);
		model.sync(listed('b'), false);

		assert.equal(model.get(), before, 'the view changed although the selection is still listed');
		assert.equal(calls, 0, 'listeners were told about a change that did not happen');
	});
});

describe('createDrawerModel: probe', () => {
	it('shows a result that answers for the selection it was started for', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		const ticket = model.startProbe();
		assert.equal(model.get().status, 'probing');
		assert.equal(model.finishProbe(ticket, { database: 'orders' }), true);
		assert.deepEqual(model.get(), { selectedKey: 'a', status: 'done', probe: { database: 'orders' } });
	});

	it('clears the previous result when a new probe starts', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		model.finishProbe(model.startProbe(), { database: 'orders' });
		model.startProbe();
		assert.deepEqual(model.get(), { selectedKey: 'a', status: 'probing', probe: null });
	});

	it('drops a probe that answers after another endpoint was picked', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		const ticket = model.startProbe();
		model.select('b');
		assert.equal(model.finishProbe(ticket, { database: 'orders' }), false);
		assert.deepEqual(model.get(), { selectedKey: 'b', status: 'idle', probe: null });
	});

	it('drops a probe that answers after the drawer was re-seeded', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		const ticket = model.startProbe();
		model.seed('a');
		assert.equal(model.finishProbe(ticket, { database: 'orders' }), false);
		assert.deepEqual(model.get(), { selectedKey: 'a', status: 'idle', probe: null });
	});

	it('drops the older of two probes', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		const older = model.startProbe();
		const newer = model.startProbe();
		assert.equal(model.finishProbe(newer, { database: 'new' }), true);
		assert.equal(model.finishProbe(older, { database: 'old' }), false);
		assert.deepEqual(model.get().probe, { database: 'new' });
	});
});

// A selection leaves the list only when the endpoint store resets: on sign-out
// and on a change of user, organization or team (the store keeps a vanished
// endpoint listed as `stopped`).
describe('createDrawerModel: the endpoint store resets', () => {
	it('forgets the selection and its finished probe when the selected endpoint leaves the list', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		model.finishProbe(model.startProbe(), { database: 'previous_team_db' });
		let calls = 0;
		model.subscribe(() => {
			calls += 1;
		});

		model.sync(listed(), true);

		assert.deepEqual(model.get(), { selectedKey: null, status: 'idle', probe: null }, 'the previous account\'s probe rows are still shown');
		assert.equal(calls, 1);
	});

	it('drops a probe still in flight, so its late answer is not shown', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		const ticket = model.startProbe();

		model.sync(listed(), true);

		assert.equal(model.finishProbe(ticket, { database: 'previous_team_db' }), false, 'the late answer was applied');
		assert.deepEqual(model.get(), { selectedKey: null, status: 'idle', probe: null });
	});

	it('forgets while the drawer is closed too', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		const ticket = model.startProbe();

		model.sync(listed(), false);

		assert.equal(model.get().selectedKey, null);
		assert.equal(model.finishProbe(ticket, { database: 'previous_team_db' }), false);
	});

	it('falls back to the first endpoint of the fresh list with no result carried over, even when the same key returns', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		model.finishProbe(model.startProbe(), { database: 'previous_team_db' });

		model.sync(listed(), true);
		model.sync(listed('a', 'b'), true);

		assert.deepEqual(model.get(), { selectedKey: 'a', status: 'idle', probe: null });
	});

	it('forgets when the list is replaced without the selection in one step', () => {
		const model = createDrawerModel<IProbe>();
		model.seed('a');
		model.finishProbe(model.startProbe(), { database: 'previous_team_db' });

		model.sync(listed('x', 'y'), true);

		assert.deepEqual(model.get(), { selectedKey: 'x', status: 'idle', probe: null });
	});
});

describe('createDrawerModel: subscription', () => {
	it('replaces the view on every change and stops notifying after unsubscribe', () => {
		const model = createDrawerModel<IProbe>();
		let calls = 0;
		const unsubscribe = model.subscribe(() => {
			calls += 1;
		});
		const first = model.get();
		model.seed('a');
		assert.notEqual(model.get(), first);
		assert.equal(calls, 1);
		unsubscribe();
		model.select('b');
		assert.equal(calls, 1);
	});
});
