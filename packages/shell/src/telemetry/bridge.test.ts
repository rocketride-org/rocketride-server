import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AFTER_LAST_PAGEVIEW_MS, BridgeLog, BRIDGED_KEY, CONTINUED_KEY, MAX_BRIDGED, copyableProperties, newJourneyKey, normalizeContinued, planBridge } from './bridge.ts';


const pv = (path: string) => ({ event: '$pageview', properties: { page: path === '/' ? 'landing' : 'pricing', path, $current_url: `https://cloud.rocketride.ai${path}?utm_source=x`, $pathname: path, $referrer: 'https://www.google.com', distinct_id: '$posthog_cookieless', $session_id: 's0', $window_id: 'w0', $pageview_id: 'pv0', token: 't', $cookieless_mode: true, consent_state: 'undecided', $prev_pageview_duration: 3, $lib: 'web', $lib_version: '1', rr_journey: 'abc', $set_once: { $initial_referrer: 'x' } } });
const sv = (section: string, order: number) => ({ event: 'section:view', properties: { page: 'landing', section, order, secs_since_pageview: 1, $session_id: 's0', rr_journey: 'abc', consent_state: 'undecided' } });

test('copyableProperties keeps the page context and drops the sending instance\'s identity, session and SDK keys', () => {
	const out = copyableProperties(pv('/').properties);
	assert.deepEqual(Object.keys(out).sort(), ['$current_url', '$pathname', '$referrer', 'page', 'path', 'rr_journey']);
	assert.deepEqual(copyableProperties(null), {});
});

test('a full BridgeLog keeps the landing view and the newest page view: the oldest entry after the landing one is evicted', () => {
	const log = new BridgeLog();
	log.record(pv('/'));
	for (let i = 0; i < MAX_BRIDGED - 1; i++) log.record(sv('features', i));
	log.record(pv('/pricing')); // the log is full: this page view must not be dropped
	const taken = log.take();
	assert.equal(taken.length, MAX_BRIDGED);
	assert.equal(taken[0].properties.path, '/', 'the landing view stays first');
	assert.equal(taken.at(-1)?.properties.path, '/pricing', 'the current page view is kept');
	assert.equal(taken[1].properties.order, 1, 'the oldest section view after the landing one made room');
	const steps = planBridge(taken);
	assert.equal(steps.at(-1)?.offsetMs, null, 'planBridge treats the current page view as the last one');
});

test('BridgeLog records only page views and section views, at most MAX_BRIDGED, and only until it is taken', () => {
	const kinds = new BridgeLog();
	kinds.record(pv('/'));
	kinds.record({ event: 'cta:click', properties: { cta_id: 'get_started' } });
	kinds.record({ event: '$pageleave', properties: {} });
	kinds.record(sv('hero', 0));
	kinds.record(null);
	assert.deepEqual(kinds.take().map((e) => e.event), ['$pageview', 'section:view']);

	const log = new BridgeLog();
	log.record(pv('/'));
	for (let i = 0; i < MAX_BRIDGED + 10; i++) log.record(sv('features', 1));
	const taken = log.take();
	assert.equal(taken[0].event, '$pageview', 'the landing page view is the first one kept');
	assert.equal(taken.length, MAX_BRIDGED);
	assert.equal(taken.filter((e) => e.event === '$pageview').length, 1);
	log.record(pv('/pricing'));
	assert.deepEqual(log.take(), [], 'one bridge per page load: nothing is recorded after take()');
});

test('planBridge keeps the order, marks every copy, and times the last page view at its real time', () => {
	const log = new BridgeLog();
	for (const e of [pv('/'), sv('hero', 0), sv('features', 1), pv('/pricing'), sv('plans', 0), sv('faq', 1)]) log.record(e);
	const steps = planBridge(log.take());
	assert.deepEqual(steps.map((s) => s.event), ['$pageview', 'section:view', 'section:view', '$pageview', 'section:view', 'section:view']);
	for (const s of steps) assert.equal(s.properties[BRIDGED_KEY], true);
	// before the last page view: strictly increasing, before the bridge moment; the last page view: real time; after: just after it
	assert.deepEqual(steps.map((s) => s.offsetMs), [-3, -2, -1, null, AFTER_LAST_PAGEVIEW_MS + 1, AFTER_LAST_PAGEVIEW_MS + 2]);
	assert.equal(steps[0].properties.$pathname, '/', 'the landing page view keeps its own path');
	assert.equal(steps[0].properties.$current_url, 'https://cloud.rocketride.ai/?utm_source=x', 'and its URL with the utm parameters');
	assert.equal(steps[0].properties.consent_state, undefined, 'consent_state comes from the consented instance');
	assert.deepEqual(planBridge([]), []);
});

test('normalizeContinued: true on the continued session, removed on any other session, untouched when absent', () => {
	const on = normalizeContinued({ properties: { [CONTINUED_KEY]: 's1', $session_id: 's1' } });
	assert.equal(on.properties[CONTINUED_KEY], true);
	const later = normalizeContinued({ properties: { [CONTINUED_KEY]: 's1', $session_id: 's2' } });
	assert.equal(CONTINUED_KEY in later.properties, false, 'a later session is a new visit');
	const none = normalizeContinued({ properties: { $session_id: 's1' } });
	assert.deepEqual(none.properties, { $session_id: 's1' });
	assert.equal(normalizeContinued(null), null);
	const twice = normalizeContinued(normalizeContinued({ properties: { [CONTINUED_KEY]: 's1', $session_id: 's1' } }));
	assert.equal(twice.properties[CONTINUED_KEY], true, 'idempotent (before_send may see an event twice)');
});

test('newJourneyKey: a UUID when available, else 32 hex characters; both match the contract', () => {
	const fixed = newJourneyKey(Math.random, () => '123e4567-e89b-42d3-a456-426614174000');
	assert.equal(fixed, '123e4567-e89b-42d3-a456-426614174000');
	const fallback = newJourneyKey(() => 0.5);
	assert.match(fallback, /^[0-9a-f]{32}$/);
	const thrown = newJourneyKey(() => 0.1, () => { throw new Error('no crypto'); });
	assert.match(thrown, /^[0-9a-f]{32}$/);
	// The contract-validation cases stay with home-ui's events.contract.json,
	// where the bridged events ($pageview, section:view) are defined.
});
