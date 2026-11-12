import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VitalsStart, enableWebVitals, WEB_VITALS_CONFIG } from './vitals.ts';

test('enableWebVitals sets the config and starts the autocapture when the instance has one', () => {
	const configs: unknown[] = [];
	let starts = 0;
	const ok = enableWebVitals({ set_config: (c) => { configs.push(c); }, webVitalsAutocapture: { startIfEnabled: () => { starts++; } } });
	assert.equal(ok, true);
	assert.deepEqual(configs, [WEB_VITALS_CONFIG]);
	assert.equal(starts, 1);
});

test('enableWebVitals reports false without a web-vitals autocapture', () => {
	assert.equal(enableWebVitals({ set_config: () => {} }), false);
});

test('enableWebVitals reports false, and does not throw, when set_config throws', () => {
	let starts = 0;
	const ok = enableWebVitals({ set_config: () => { throw new Error('no'); }, webVitalsAutocapture: { startIfEnabled: () => { starts++; } } });
	assert.equal(ok, false);
	assert.equal(starts, 0, 'nothing is started after the failed config');
});

/** A VitalsStart over a fake page: `state` is read live, every enable is counted. */
function vitalsHarness() {
	const state = { started: true, page: false };
	const reports: string[] = [];
	let enables = 0;
	const start = new VitalsStart({
		sdkStarted: () => state.started,
		isPage: () => state.page,
		enable: () => { enables++; return true; },
		report: (detail) => { reports.push(detail); },
	});
	return { state, reports, start, enables: () => enables };
}

test('VitalsStart: a load that settles on a shell screen measures nothing until an app page becomes active, then once', () => {
	const h = vitalsHarness();
	h.start.extensionLoaded(); // the waitlist or loading screen is up
	assert.equal(h.enables(), 0, 'no web vitals on a shell screen');
	h.state.page = true;
	h.start.pageActivated();
	assert.equal(h.enables(), 1, "the app page's metrics are measured");
	assert.deepEqual(h.reports, ['started']);
	h.start.pageActivated();
	h.start.extensionLoaded();
	assert.equal(h.enables(), 1, 'one start per page load');
});

test('VitalsStart: on an app page it starts when the extension lands; never before the SDK started or the extension loaded', () => {
	const h = vitalsHarness();
	h.state.page = true;
	h.start.pageActivated();
	assert.equal(h.enables(), 0, 'the extension is not in yet');
	h.state.started = false;
	h.start.extensionLoaded();
	assert.equal(h.enables(), 0, 'the SDK has not started');
	h.state.started = true;
	h.start.pageActivated();
	assert.equal(h.enables(), 1);
});
