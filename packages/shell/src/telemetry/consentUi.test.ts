import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onOpenConsentBanner, openConsentBanner, shouldMountConsentBanner, takePendingOpen } from './consentUi.ts';

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

test('telemetry off for another reason (init failed, no signal): no banner even on request', () => {
	assert.equal(shouldMountConsentBanner({ ...base, telemetryLive: false, settled: true, requested: true }), false);
});
