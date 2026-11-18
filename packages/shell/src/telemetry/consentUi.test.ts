import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasPendingOpen, subscribeConsentHost, onOpenConsentBanner, openConsentBanner, shouldMountConsentBanner, takePendingOpen, privacySectionVisible, privacyToggleAction } from './consentUi.ts';

// The two listeners the site has: HomeApp's lazy host (mounts the banner, does not take the request) and the
// mounted banner (takes the request and opens).

test('a request before the banner mounted stays pending while only the lazy host listens; the banner takes it once', () => {
	takePendingOpen();
	let hostCalls = 0;
	const offHost = onOpenConsentBanner(() => {
		hostCalls += 1;
	});
	openConsentBanner();
	assert.equal(hostCalls, 1, 'the host mounts the banner');
	assert.equal(takePendingOpen(), true, 'the banner, mounting now, opens from the request');
	assert.equal(takePendingOpen(), false, 'at most once per request');
	offHost();
});

test('a request the mounted banner handled is not left pending: a later remount does not reopen it', () => {
	takePendingOpen();
	let opened = 0;
	const offBanner = onOpenConsentBanner(() => {
		takePendingOpen();
		opened += 1;
	});
	openConsentBanner();
	assert.equal(opened, 1);
	offBanner();
	assert.equal(takePendingOpen(), false, 'nothing for the next mount');
});

test('the Privacy toggle: a privacy signal blocks the opt-in, never the withdrawal of an earlier acceptance', () => {
	assert.equal(privacyToggleAction('accepted', false), 'withdraw');
	assert.equal(privacyToggleAction('accepted', true), 'withdraw', 'withdrawal stays reachable under the signal');
	assert.equal(privacyToggleAction('rejected', false), 'accept');
	assert.equal(privacyToggleAction('undecided', false), 'accept');
	assert.equal(privacyToggleAction('rejected', true), null, 'no opt-in under the signal');
	assert.equal(privacyToggleAction('undecided', true), null);
});

test('the Privacy section shows while telemetry is live, and for an acceptance on record even when it is not', () => {
	assert.equal(privacySectionVisible(true, 'undecided'), true);
	assert.equal(privacySectionVisible(false, 'accepted'), true, 'a stored acceptance stays withdrawable with capture off');
	assert.equal(privacySectionVisible(false, 'rejected'), false);
	assert.equal(privacySectionVisible(false, 'undecided'), false);
});

// ==== shouldMountConsentBanner: when the lazy host mounts the banner =========

const base = { hasKey: true, storedConsent: true, telemetryLive: true, privacySignal: false, settled: false, requested: false };

test('live telemetry: the banner mounts once the page settled, or at once on a "Privacy settings" request', () => {
	assert.equal(shouldMountConsentBanner(base), false, 'not before settle, unasked');
	assert.equal(shouldMountConsentBanner({ ...base, settled: true }), true);
	assert.equal(shouldMountConsentBanner({ ...base, requested: true }), true);
});

test('a privacy signal: never shown unasked, but "Privacy settings" still opens it (it states the signal is honoured)', () => {
	const signal = { ...base, telemetryLive: false, privacySignal: true };
	assert.equal(shouldMountConsentBanner(signal), false);
	assert.equal(shouldMountConsentBanner({ ...signal, settled: true }), false, 'no auto-shown banner to a signal visitor');
	assert.equal(shouldMountConsentBanner({ ...signal, requested: true }), true, 'the explicit request is honoured');
	assert.equal(shouldMountConsentBanner({ ...signal, settled: true, requested: true }), true);
});

test('keyless (OSS) or host-governed (VS Code): no banner, even on request or under a signal', () => {
	for (const over of [{ hasKey: false }, { storedConsent: false }]) {
		for (const privacySignal of [false, true]) {
			const i = { ...base, ...over, telemetryLive: false, privacySignal, settled: true, requested: true };
			assert.equal(shouldMountConsentBanner(i), false, JSON.stringify(i));
		}
	}
});

test('a privacy signal: a request made before the lazy host subscribed still mounts the banner, which then takes it', () => {
	takePendingOpen();
	openConsentBanner();
	let requested = false;
	const offHost = subscribeConsentHost(() => {
		requested = true;
	});
	const signal = { ...base, telemetryLive: false, privacySignal: true, settled: true };
	assert.equal(requested, true, 'the host sees the early request on subscribe');
	assert.equal(hasPendingOpen(), true, 'the check leaves the request for the banner');
	assert.equal(shouldMountConsentBanner({ ...signal, requested }), true);
	assert.equal(takePendingOpen(), true, 'the mounted banner opens from it');
	offHost();
});

test('a privacy signal: with no request pending, subscribing does not mount the banner', () => {
	takePendingOpen();
	let requested = false;
	const offHost = subscribeConsentHost(() => {
		requested = true;
	});
	assert.equal(requested, false);
	assert.equal(shouldMountConsentBanner({ ...base, telemetryLive: false, privacySignal: true, settled: true, requested }), false);
	offHost();
});

test('subscribeConsentHost: an early request fires once on subscribe and stays pending; later requests fire; unsubscribe stops them', () => {
	takePendingOpen();
	openConsentBanner();
	let calls = 0;
	const off = subscribeConsentHost(() => {
		calls += 1;
	});
	assert.equal(calls, 1, 'the early request fires once on subscribe');
	assert.equal(hasPendingOpen(), true, 'subscribing does not consume the request');
	openConsentBanner();
	assert.equal(calls, 2, 'a later request fires again');
	off();
	openConsentBanner();
	assert.equal(calls, 2, 'no calls after unsubscribe');
	assert.equal(takePendingOpen(), true);
	assert.equal(hasPendingOpen(), false, 'clean state for the next test');
});

test('telemetry off for another reason (init failed, no signal): no banner even on request', () => {
	assert.equal(shouldMountConsentBanner({ ...base, telemetryLive: false, settled: true, requested: true }), false);
});

test('the banner host subscribes with subscribeConsentHost, so a request made before it mounts is honoured', () => {
	// ConsentBannerHost is a component and the shell has no render tests yet,
	// so pin its subscription by source: onOpenConsentBanner would consume or
	// miss a request made before the host subscribed (the f8bf682 fix).
	const source = readFileSync(new URL('./ConsentBannerHost.tsx', import.meta.url), 'utf8');
	assert.match(source, /subscribeConsentHost\(/);
	assert.doesNotMatch(source, /onOpenConsentBanner\(/);
});
