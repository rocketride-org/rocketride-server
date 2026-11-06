import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onOpenConsentBanner, openConsentBanner, takePendingOpen } from './consentUi.ts';

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
