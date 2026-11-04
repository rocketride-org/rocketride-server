import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableWebVitals, WEB_VITALS_CONFIG } from './vitals.ts';

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
