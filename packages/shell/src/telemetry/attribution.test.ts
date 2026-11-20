// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

// The attribution tag end to end: only events sent through getConsentedCapture's
// report carry ATTRIBUTED_TAG, no app can set it by hand (per-event props or
// super properties), and the before_send gates drop or strip it at send time.

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult } from 'posthog-js';

/** A Web Storage double. */
function memoryStorage() {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => {
			data.set(k, v);
		},
		removeItem: (k: string) => {
			data.delete(k);
		},
	};
}

// The consent store reads localStorage live from when consentState.ts loads, so
// it goes in before any telemetry module is imported. The page globals go in
// after the chunk's modules load: posthog-js reads window at import, and in
// node it must find none (as in consented.test.ts).
const local = memoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
const timers: Array<() => void> = [];
const win: Record<string, unknown> = {
	location: { search: '', pathname: '/', hostname: 'cloud.example.test' },
	setTimeout: (fn: () => void) => {
		timers.push(fn); // never run: the queue stays pending, so its entries can be peeked
		return timers.length;
	},
	addEventListener: () => {},
	innerWidth: 1280,
	innerHeight: 800,
};
win.self = win;
win.top = win;

let host: typeof import('./host.ts');
let consent: typeof import('./consent.ts');
let consented: typeof import('./consented.ts');
let transport: typeof import('./transport.ts');
before(async () => {
	consent = await import('./consent.ts');
	consented = await import('./consented.ts');
	transport = await import('./transport.ts');
	for (const [key, value] of Object.entries({ window: win, document: { visibilityState: 'hidden' }, sessionStorage: memoryStorage() })) {
		Object.defineProperty(globalThis, key, { configurable: true, value });
	}
	host = await import('./host.ts');
});

/** Write the device's consent record, as the banner does. */
function setConsent(choice: 'accepted' | 'rejected' | null): void {
	if (choice === null) {
		local.removeItem(consent.CONSENT_KEY);
		return;
	}
	local.setItem(consent.CONSENT_KEY, JSON.stringify({ v: consent.CONSENT_VERSION, choice, at: Date.now() }));
}

/** A fresh host with a fake transport chunk that has a consented session; the SDK never starts. */
function freshHost(): void {
	// A new tab: no hold inherited from the previous test's queue.
	Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() });
	host.resetTelemetryHostForTests();
	const module = {
		bindTransport: () => {},
		transportIdentity: () => ({}),
		startWebVitals: () => {},
		initPostHog: () => {},
		active: () => null,
		registerOnInstances: () => {},
		syncPageActive: () => {},
		consentedSession: () => ({ sessionId: 's1', signedOut: true }),
		onConsentedSessionId: () => () => {},
	};
	host.loadTransportForTests(module as unknown as Parameters<typeof host.loadTransportForTests>[0]);
}

/** Bind the consented chunk's host so its before_send reads `consentedActive` and no privacy signal. */
function bindConsented(consentedActive: boolean): void {
	const sdk = { capture: () => undefined, register: () => {} };
	consented.bindConsentHost({
		mode: () => ({ isConsented: () => consentedActive, active: () => sdk }) as never,
		sdkStarted: () => true,
		isShellScreen: () => false,
		privacySignal: () => false,
		signedOut: () => true,
		visibleLoad: () => true,
		ensureInit: () => true,
		register: () => {},
		send: () => {},
		freshJourneyKey: () => 'j',
		identify: () => {},
	});
}

/** A queued entry as posthog-js's before_send would receive it. */
function asEvent(entry: { event: string; props: Record<string, unknown> }): CaptureResult {
	return { uuid: 'u', event: entry.event, properties: { ...entry.props } } as unknown as CaptureResult;
}

test('getConsentedCapture report tags its queue entry; cookieless drops it, consented sends it without the tag', () => {
	setConsent('accepted');
	freshHost();
	const capture = host.getConsentedCapture(host.getReporter('home-ui'));
	assert.ok(capture);
	assert.equal(capture.report('homepage_roulette_viewed', { assignment_id: 'a1', exposure_id: 'e1' }), true);
	host.getReporter('home-ui')('cta:click', { assignment_id: 'a1' });
	const [tagged, plain] = host.peekQueuedCaptures();
	assert.equal(tagged.props[consent.ATTRIBUTED_TAG], true);
	assert.equal(consent.ATTRIBUTED_TAG in plain.props, false, 'the plain reporter never tags, whatever the property names');

	bindConsented(false);
	assert.equal(transport.cookielessBeforeSend(asEvent(tagged)), null);
	bindConsented(true);
	const out = consented.consentedBeforeSend(asEvent(tagged));
	assert.ok(out);
	assert.equal(out.properties.assignment_id, 'a1');
	assert.equal(consent.ATTRIBUTED_TAG in out.properties, false);
});

test('a tagged entry replayed after a withdrawal is dropped', () => {
	setConsent('accepted');
	freshHost();
	host.getConsentedCapture(host.getReporter('home-ui'))?.report('homepage_roulette_viewed', { assignment_id: 'a1' });
	const [tagged] = host.peekQueuedCaptures();
	setConsent('rejected');
	bindConsented(true); // this tab's mode has not switched yet: consent is read live
	assert.equal(consented.consentedBeforeSend(asEvent(tagged)), null);
	bindConsented(false);
	assert.equal(transport.cookielessBeforeSend(asEvent(tagged)), null);
});

test('an app cannot set the tag by hand: per-event props and super properties are stripped', () => {
	setConsent(null);
	freshHost();
	host.registerSuperProperties({ [consent.ATTRIBUTED_TAG]: true, plan: 'free' });
	host.getReporter('acme.chat')('task:assigned', { [consent.ATTRIBUTED_TAG]: true, assignment_id: 't1' });
	const [entry] = host.peekQueuedCaptures();
	assert.equal(consent.ATTRIBUTED_TAG in entry.props, false);
	assert.equal(entry.props.plan, 'free', 'the other super properties still apply');
	assert.equal(entry.props.assignment_id, 't1');
});

test('the tagging window closes even when the app reporter throws', () => {
	setConsent('accepted');
	freshHost();
	const capture = host.getConsentedCapture(() => {
		throw new Error('reporter broke');
	});
	assert.ok(capture);
	assert.throws(() => capture.report('homepage_roulette_viewed', { assignment_id: 'a1' }));
	host.getReporter('home-ui')('cta:click', { cta_id: 'docs' });
	const [entry] = host.peekQueuedCaptures();
	assert.equal(consent.ATTRIBUTED_TAG in entry.props, false);
});

test('a consented report nested inside another keeps the outer event tagged', () => {
	setConsent('accepted');
	freshHost();
	const reporter = host.getReporter('home-ui');
	const inner = host.getConsentedCapture(reporter);
	assert.ok(inner);
	const outer = host.getConsentedCapture((event, props, options) => {
		inner.report('inner', {});
		reporter(event, props, options);
	});
	assert.ok(outer);
	outer.report('outer', {});
	const entries = host.peekQueuedCaptures();
	assert.deepEqual(entries.map((e) => [e.event, e.props[consent.ATTRIBUTED_TAG]]), [['inner', true], ['outer', true]]);
});
