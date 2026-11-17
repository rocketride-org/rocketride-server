// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

// Consent at SEND time for experiment-attributed events (assignment_id /
// exposure_id), end to end through the real SdkQueue and the real before_send
// functions of both instances. posthog-js runs before_send synchronously
// inside capture(), so the fake SDK below does the same: the moment an event
// reaches before_send is the moment it is sent or handed to posthog-js's own
// batch. An app reports under consent; the event can still reach posthog-js
// later — replayed from the pre-start queue, or from an earlier page load's
// sessionStorage hold — and must not go out if consent no longer holds then
// (home-ui's former consented before_send dropped it the same way).

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult } from 'posthog-js';
import { CONSENT_KEY, CONSENT_VERSION } from './consent.ts';
import { HOLD_STORAGE_KEY, SdkQueue, newEventUuid, type HoldStorage } from './sdkQueue.ts';

/** A Web Storage double. */
function memoryStorage(): HoldStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => {
			data.set(k, v);
		},
		removeItem: (k) => {
			data.delete(k);
		},
	};
}

// The consent store is created when consentState.ts loads and reads localStorage live from then on:
// install it first, then load the chunk's modules.
const local = memoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
let bindConsentHost: typeof import('./consented.ts').bindConsentHost;
let consentedBeforeSend: typeof import('./consented.ts').consentedBeforeSend;
let cookielessBeforeSend: typeof import('./transport.ts').cookielessBeforeSend;
before(async () => {
	({ bindConsentHost, consentedBeforeSend } = await import('./consented.ts'));
	({ cookielessBeforeSend } = await import('./transport.ts'));
});

/** Write the device's consent record, as the banner (this tab or another) does. */
function setConsent(choice: 'accepted' | 'rejected' | null): void {
	if (choice === null) {
		local.removeItem(CONSENT_KEY);
		return;
	}
	local.setItem(CONSENT_KEY, JSON.stringify({ v: CONSENT_VERSION, choice, at: Date.now() }));
}

const EXPOSURE = {
	experiment: 'homepage',
	assignment_id: '6f1c2f0e-8f6a-4c55-9b7e-0d7a3c1d2e4f',
	exposure_id: '3b0c8c7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
	variant_id: 'mh-1',
};

type Sent = { instance: 'consented' | 'cookieless'; event: string; props: Record<string, unknown> };

/**
 * One page load: the capture mode (`consented` = the consented instance is the active one), the privacy signal,
 * a fake posthog-js whose capture() runs the active instance's before_send, and the real queue over it.
 */
function pageLoad(storage = memoryStorage()) {
	const state = { consented: true, gpc: false };
	const sent: Sent[] = [];
	const sdk = {
		capture: (event: string, props?: Record<string, unknown> | null) => {
			const instance = state.consented ? 'consented' : 'cookieless';
			const before = instance === 'consented' ? consentedBeforeSend : cookielessBeforeSend;
			const out = before({ event, properties: { ...(props ?? {}) } } as unknown as CaptureResult);
			if (out) sent.push({ instance, event, props: out.properties as Record<string, unknown> });
			return undefined;
		},
		register: () => {},
	};
	const mode = {
		isConsented: () => state.consented,
		active: () => sdk,
	};
	bindConsentHost({
		mode: () => mode as never,
		sdkStarted: () => true,
		isShellScreen: () => false,
		privacySignal: () => state.gpc,
		signedOut: () => true,
		visibleLoad: () => true,
		ensureInit: () => true,
		register: () => {},
		send: () => {},
		freshJourneyKey: () => 'j',
		identify: () => {},
	});
	const queue = new SdkQueue({ init: () => {}, target: () => sdk, register: () => {}, onFailure: () => {}, storage });
	return { state, sent, queue, storage };
}

test('control: consent still accepted at the start, the queued exposure goes out on the consented instance', () => {
	setConsent('accepted');
	const p = pageLoad();
	p.queue.capture('cta:click', { cta_id: 'get_started', intent: 'register', ...EXPOSURE }, { transport: 'sendBeacon' });
	p.queue.start();
	assert.deepEqual(p.sent.map((s) => [s.instance, s.event, s.props.assignment_id]), [['consented', 'cta:click', EXPOSURE.assignment_id]]);
});

test('withdrawn before the start: the queued attributed event is dropped, the unattributed one goes out cookieless', () => {
	setConsent('accepted');
	const p = pageLoad();
	p.queue.capture('cta:click', { cta_id: 'get_started', intent: 'register', ...EXPOSURE }, { transport: 'sendBeacon' });
	p.queue.capture('cta:click', { cta_id: 'docs' });
	assert.ok((p.storage.getItem(HOLD_STORAGE_KEY) ?? '').includes(EXPOSURE.assignment_id), 'held while pending');
	setConsent('rejected'); // the withdrawal; the start creates the capture mode from it
	p.state.consented = false;
	p.queue.start();
	assert.deepEqual(p.sent.map((s) => [s.instance, s.event, s.props.cta_id]), [['cookieless', 'cta:click', 'docs']]);
	assert.equal(JSON.stringify(p.sent).includes(EXPOSURE.assignment_id), false);
	assert.equal(p.storage.getItem(HOLD_STORAGE_KEY), null, 'the drain empties the hold');
});

test('withdrawn in another tab, storage event not yet followed: the consented instance still drops it (consent read live)', () => {
	setConsent('accepted');
	const p = pageLoad();
	p.queue.capture('homepage_roulette_viewed', { ...EXPOSURE }, { transport: 'sendBeacon' });
	setConsent('rejected'); // written by another tab; this tab's mode has not switched yet
	p.queue.start();
	assert.deepEqual(p.sent, []);
});

test('an earlier load held the exposure (OAuth round trip), consent withdrawn since: the next load drops it at drain', () => {
	const storage = memoryStorage();
	storage.setItem(HOLD_STORAGE_KEY, JSON.stringify([
		{ event: 'cta:click', props: { cta_id: 'get_started', intent: 'register', ...EXPOSURE }, ts: Date.now() - 1000, id: newEventUuid() },
		{ event: '$pageview', props: {}, ts: Date.now() - 1000, id: newEventUuid() },
	]));
	setConsent('rejected');
	const p = pageLoad(storage);
	p.state.consented = false;
	p.queue.start();
	assert.deepEqual(p.sent.map((s) => [s.instance, s.event]), [['cookieless', '$pageview']]);
	assert.equal(storage.getItem(HOLD_STORAGE_KEY), null);
});

test('a privacy signal (DNT/GPC) on at send time drops a queued attributed event even with consent accepted', () => {
	setConsent('accepted');
	const p = pageLoad();
	p.queue.capture('homepage_roulette_viewed', { ...EXPOSURE }, { transport: 'sendBeacon' });
	p.queue.capture('cta:click', { cta_id: 'docs' });
	p.state.gpc = true;
	p.queue.start();
	assert.deepEqual(p.sent.map((s) => [s.instance, s.event]), [['consented', 'cta:click']]);
});

test('an attributed event never goes out cookieless, even while undecided (the per-load roulette_assignment_id tag does)', () => {
	setConsent(null);
	const p = pageLoad();
	p.state.consented = false;
	p.queue.start();
	p.queue.capture('cta:click', { cta_id: 'get_started', ...EXPOSURE });
	p.queue.capture('cta:click', { cta_id: 'get_started', roulette_assignment_id: EXPOSURE.assignment_id, roulette_variant: 'mh-1' });
	assert.deepEqual(p.sent.map((s) => s.props.roulette_assignment_id), [EXPOSURE.assignment_id]);
});
