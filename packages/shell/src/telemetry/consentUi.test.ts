import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onOpenConsentBanner, openConsentBanner, privacySectionVisible, privacyToggleAction, takePendingOpen } from './consentUi.ts';

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
