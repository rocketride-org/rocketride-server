import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureMode, INERT_CONFIG, clearPostHogStorage, type SdkLike } from './mode.ts';

function fakeSdk(name: string, log: string[]): SdkLike & { registered: Record<string, unknown> } {
	const registered: Record<string, unknown> = {};
	return {
		registered,
		capture: (e) => { log.push(`${name}:capture:${e}`); return undefined; },
		register: (p) => { Object.assign(registered, p); log.push(`${name}:register:${Object.keys(p).sort().join(',')}`); },
		opt_out_capturing: () => { log.push(`${name}:opt_out`); },
		set_config: (c) => { log.push(`${name}:set_config:${Object.keys(c).join(',')}`); },
		reset: () => { log.push(`${name}:reset`); },
		stopSessionRecording: () => { log.push(`${name}:stopRecording`); },
	};
}

function setup(createFails = false) {
	const log: string[] = [];
	const cookieless = fakeSdk('cookieless', log);
	const consented = fakeSdk('consented', log);
	let created = 0;
	const mode = new CaptureMode({
		cookieless,
		createConsented: () => { created += 1; if (createFails) throw new Error('boom'); return consented; },
		clearSdkStorage: () => { log.push('clearStorage'); },
		superProperties: () => ({ app: 'home-ui', rr_traffic: 'visible' }),
		later: (fn, ms) => { log.push(`later:${ms}`); fn(); },
		// Marker values, not real config: the test only asserts they round-trip into set_config.
		captureConfig: ((signedIn: boolean) => (signedIn ? { autocapture: false, capture_heatmaps: false } : { autocapture: { x: 1 }, capture_heatmaps: { y: 1 } })) as (signedIn: boolean) => Partial<import('posthog-js').PostHogConfig>,
	});
	return { log, cookieless, consented, mode, created: () => created };
}

test('undecided and rejected route to the cookieless instance; consent_state is registered', () => {
	const { mode, cookieless, consented, created } = setup();
	mode.apply('undecided');
	assert.equal(mode.active(), cookieless);
	assert.equal(cookieless.registered.consent_state, 'undecided');
	mode.apply('rejected');
	assert.equal(mode.active(), cookieless);
	assert.equal(cookieless.registered.consent_state, 'rejected');
	assert.equal(created(), 0, 'no consented instance without acceptance');
	assert.equal(consented.registered.consent_state, undefined);
});

test('accepting creates the consented instance once, with the super properties, and routes to it', () => {
	const { mode, consented, created, log } = setup();
	mode.apply('undecided');
	mode.apply('accepted');
	assert.equal(mode.active(), consented);
	assert.equal(mode.isConsented(), true);
	assert.deepEqual(consented.registered, { app: 'home-ui', rr_traffic: 'visible', consent_state: 'accepted' });
	mode.apply('accepted');
	assert.equal(created(), 1, 'created once per page load');
	assert.ok(!log.includes('consented:reset'));
});

test('withdrawal from accepted stops the recording, opts out, resets, clears storage and routes back', () => {
	const { mode, cookieless, consented, log } = setup();
	mode.apply('accepted');
	log.length = 0;
	mode.apply('undecided');
	assert.equal(mode.active(), cookieless);
	assert.deepEqual(log, ['consented:stopRecording', 'consented:opt_out', 'consented:set_config:disable_persistence,capture_pageleave,capture_heatmaps,autocapture,capture_dead_clicks,capture_exceptions,capture_performance,disable_session_recording,before_send', 'consented:reset', 'consented:opt_out', 'clearStorage', 'later:0', 'clearStorage', 'later:1000', 'clearStorage', 'cookieless:register:consent_state']);
	assert.equal(cookieless.registered.consent_state, 'undecided');
	assert.equal(mode.isConsented(), false);
	mode.apply('accepted');
	assert.equal(mode.active(), consented, 'a later acceptance switches again');
});

test('setSignedIn: sign-in stops the recording and switches the element captures off; sign-out switches them on; a no-op while cookieless', () => {
	const { mode, log } = setup();
	mode.setSignedIn(true);
	assert.equal(log.length, 0, 'nothing to do while cookieless');
	mode.apply('accepted');
	log.length = 0;
	mode.setSignedIn(true);
	assert.deepEqual(log, ['consented:stopRecording', 'consented:set_config:autocapture,capture_heatmaps']);
	log.length = 0;
	mode.setSignedIn(false);
	assert.deepEqual(log, ['consented:set_config:autocapture,capture_heatmaps'], 'sign-out: captures back on, the recording stays stopped');
});

test('consented-only properties (rr_replay_gate) are registered on acceptance and again after the sign-out reset', () => {
	const log: string[] = [];
	const cookieless = fakeSdk('cookieless', log);
	const consented = fakeSdk('consented', log);
	const mode = new CaptureMode({
		cookieless, createConsented: () => consented, clearSdkStorage: () => {}, superProperties: () => ({ app: 'home-ui' }),
		consentedProperties: () => ({ rr_replay_gate: 'low_memory' }),
	});
	mode.apply('accepted');
	assert.equal(consented.registered.rr_replay_gate, 'low_memory');
	assert.equal(cookieless.registered.rr_replay_gate, undefined, 'never on the cookieless instance');
	delete consented.registered.rr_replay_gate; // what reset() does to registered properties
	mode.resetIdentity();
	assert.equal(consented.registered.rr_replay_gate, 'low_memory');
});

test('every sign-in stops the recording, also after a sign-out (a recording restarted on the signed-out surface never survives the next sign-in)', () => {
	const { mode, log } = setup();
	mode.apply('accepted');
	for (let i = 0; i < 3; i++) {
		log.length = 0;
		mode.setSignedIn(true);
		assert.equal(log.filter((l) => l === 'consented:stopRecording').length, 1, `sign-in ${i + 1} stops the recording`);
		mode.setSignedIn(false);
	}
});

test('resetIdentity (sign-out) resets the consented instance and registers the super properties again; a no-op otherwise', () => {
	const { mode, consented, log } = setup();
	mode.resetIdentity();
	assert.equal(log.filter((l) => l.includes('reset')).length, 0, 'nothing to reset while cookieless');
	mode.apply('accepted');
	log.length = 0;
	mode.resetIdentity();
	assert.deepEqual(log, ['consented:reset', 'consented:register:app,consent_state,rr_traffic']);
	assert.equal(consented.registered.consent_state, 'accepted');
	assert.equal(mode.active(), consented);
});

test('a sign-out reset that throws makes the consented instance inert and routes captures to the cookieless one for the rest of the page load', () => {
	const { mode, cookieless, consented, log, created } = setup();
	mode.apply('accepted');
	consented.reset = () => { log.push('consented:reset'); throw new Error('flushBeforeIdentityReset failed'); };
	mode.resetIdentity();
	assert.equal(mode.isConsented(), false, 'the instance that may hold the previous identity is out');
	assert.equal(mode.active(), cookieless, 'later captures go to the cookieless instance');
	assert.ok(log.includes('consented:opt_out'), 'opted out');
	assert.ok(log.includes('consented:set_config:' + Object.keys(INERT_CONFIG).join(',')), 'made inert');
	assert.ok(log.includes('clearStorage'), 'the stored identified identity is cleared');
	assert.equal(mode.state(), 'accepted', 'the consent record is not changed');
	mode.apply('accepted');
	assert.equal(mode.active(), cookieless, 'no acceptance revives it in this page load');
	assert.equal(created(), 1);
});

test('withdraw then accept again in one page load asks for the consented instance again and routes to it', () => {
	const { mode, consented, cookieless, created } = setup();
	mode.apply('accepted');
	mode.apply('undecided');
	assert.equal(mode.active(), cookieless);
	mode.apply('accepted');
	assert.equal(created(), 2, 'createConsented is asked again (it revives the torn-down instance)');
	assert.equal(mode.active(), consented);
	assert.equal(consented.registered.consent_state, 'accepted');
});

test("an opt-in again before the delayed clears run keeps the revived instance's storage", () => {
	const log: string[] = [];
	const consented = fakeSdk('consented', log);
	const timers: Array<() => void> = [];
	const mode = new CaptureMode({
		cookieless: fakeSdk('cookieless', log),
		createConsented: () => consented,
		clearSdkStorage: () => { log.push('clearStorage'); },
		superProperties: () => ({}),
		later: (fn) => { timers.push(fn); },
	});
	const clears = (): number => log.filter((l) => l === 'clearStorage').length;
	mode.apply('accepted');
	mode.apply('rejected');
	assert.equal(clears(), 1, 'cleared at once');
	mode.apply('accepted'); // the visitor opts in again within the second
	for (const fn of timers.splice(0)) fn();
	assert.equal(clears(), 1, 'the delayed clears skip while the revived instance is active');
	mode.apply('rejected');
	for (const fn of timers.splice(0)) fn();
	assert.equal(clears(), 4, 'after a final withdrawal they run: at once and twice later');
});

test('a failing consented instance keeps the cookieless routing', () => {
	const failing = setup(true);
	failing.mode.apply('accepted');
	assert.equal(failing.mode.active(), failing.cookieless);
	assert.equal(failing.mode.isConsented(), false);
	assert.equal(failing.cookieless.registered.consent_state, 'accepted', 'the state is still reported');
});

test('clearPostHogStorage removes ph_ keys from both storages and expires ph_ cookies', () => {
	const mk = (keys: string[]) => { const d = new Map(keys.map((k) => [k, '1'])); return { get length() { return d.size; }, key: (i: number) => Array.from(d.keys())[i] ?? null, removeItem: (k: string) => { d.delete(k); }, d }; };
	const local = mk(['ph_phc_x_posthog', 'rr:consent', '__ph_opt_in_out_x']); const session = mk(['ph_phc_x_window_id', 'rr:auth:start_ts']);
	const doc = { cookie: 'ph_phc_x_posthog=abc; other=1' };
	const written: string[] = [];
	const docProxy = { get cookie() { return doc.cookie; }, set cookie(v: string) { written.push(v); } };
	clearPostHogStorage(docProxy, local, session, 'cloud.rocketride.ai');
	assert.deepEqual(Array.from(local.d.keys()), ['rr:consent']);
	assert.deepEqual(Array.from(session.d.keys()), ['rr:auth:start_ts']);
	assert.ok(written.some((w) => w.startsWith('ph_phc_x_posthog=;') && w.includes('domain=.rocketride.ai')));
	assert.ok(written.every((w) => !w.startsWith('other=')));
	clearPostHogStorage(null, null, null);
});
