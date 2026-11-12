import { test } from 'node:test';
// (reload: another tab's storage write)
import assert from 'node:assert/strict';
import { ConsentStore, parseConsent, CONSENT_KEY, CONSENT_TTL_MS, CONSENT_VERSION, MAX_TIMER_MS, type ConsentTimers } from './consent.ts';

function fakeStorage() {
	const data = new Map<string, string>();
	return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}

test('a fresh visitor is undecided; a decision is stored, versioned and timestamped; listeners fire on change only', () => {
	const storage = fakeStorage(); const seen: string[] = [];
	const store = new ConsentStore({ storage, now: () => 1_000 });
	store.subscribe((s) => seen.push(s));
	assert.equal(store.state(), 'undecided');
	store.decide('accepted');
	assert.equal(store.state(), 'accepted');
	assert.deepEqual(JSON.parse(storage.data.get(CONSENT_KEY)!), { v: CONSENT_VERSION, choice: 'accepted', at: 1_000 });
	store.decide('accepted');
	store.decide('rejected');
	assert.deepEqual(seen, ['accepted', 'rejected']);
});

test('a returning visitor reads the stored choice; expiry and a version bump read as undecided', () => {
	const storage = fakeStorage();
	new ConsentStore({ storage, now: () => 5_000 }).decide('rejected');
	assert.equal(new ConsentStore({ storage, now: () => 5_000 + CONSENT_TTL_MS }).state(), 'rejected', 'at the edge of the TTL');
	assert.equal(new ConsentStore({ storage, now: () => 5_000 + CONSENT_TTL_MS + 1 }).state(), 'undecided', 'expired');
	assert.equal(new ConsentStore({ storage, now: () => 6_000, version: 2 }).state(), 'undecided', 'a version bump re-prompts');
	assert.equal(new ConsentStore({ storage, now: () => 6_000 }).state(), 'rejected', 'the old record still serves the old version');
});

test('a change of mind: accepted then rejected is stored and emitted once', () => {
	const storage = fakeStorage(); const seen: string[] = [];
	const store = new ConsentStore({ storage, now: () => 1 });
	store.decide('accepted');
	store.subscribe((s) => seen.push(s));
	store.decide('rejected');
	store.decide('rejected');
	assert.equal(store.state(), 'rejected');
	assert.equal(JSON.parse(storage.data.get(CONSENT_KEY) ?? '{}').choice, 'rejected');
	assert.deepEqual(seen, ['rejected']);
});

test('corrupt records read as undecided', () => {
	for (const raw of ['{not json', '[]', 'null', '{"v":1}', '{"v":1,"choice":"maybe","at":1}', '{"v":1,"choice":"accepted","at":"x"}', '{"v":"1","choice":"accepted","at":1}']) {
		assert.equal(parseConsent(raw, 10), null, raw);
	}
	assert.equal(parseConsent('{"v":1,"choice":"accepted","at":100000}', 10), null, 'a record from a clock far ahead is not trusted');
	assert.deepEqual(parseConsent('{"v":1,"choice":"accepted","at":5,"extra":true}', 10), { v: 1, choice: 'accepted', at: 5 });
});

test('a throwing or absent storage never throws; the choice holds in memory for the page', () => {
	const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
	const store = new ConsentStore({ storage: throwing, now: () => 1 });
	assert.equal(store.state(), 'undecided');
	store.decide('accepted');
	assert.equal(store.state(), 'accepted');
	store.decide('rejected');
	assert.equal(store.state(), 'rejected');
	const none = new ConsentStore({ storage: null, now: () => 1 });
	none.decide('rejected');
	assert.equal(none.state(), 'rejected');
});

test('reload follows another tab: a removed record emits undecided with origin external, an added one accepted; unchanged state emits nothing', () => {
	const store = new Map<string, string>();
	const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
	const consent = new ConsentStore({ storage, now: () => 1_000_000 });
	const seen: Array<[string, string]> = [];
	consent.subscribe((state, origin) => { seen.push([state, origin]); });
	consent.decide('accepted');
	assert.deepEqual(seen, [['accepted', 'local']]);
	store.delete('rr:consent'); // the other tab withdrew
	consent.reload();
	assert.equal(consent.state(), 'undecided');
	assert.deepEqual(seen.at(-1), ['undecided', 'external']);
	consent.reload();
	assert.equal(seen.length, 2, 'no change, no emit');
	store.set('rr:consent', JSON.stringify({ v: 1, choice: 'rejected', at: 999_000 })); // the other tab rejected
	consent.reload();
	assert.deepEqual(seen.at(-1), ['rejected', 'external']);
	assert.equal(consent.state(), 'rejected');
});

test('a decision whose write fails wins over the stale stored record, and listeners still fire', () => {
	const storage = fakeStorage();
	storage.data.set(CONSENT_KEY, JSON.stringify({ v: CONSENT_VERSION, choice: 'accepted', at: Date.now() }));
	// writes throw (quota), reads and removals still work: the stale 'accepted' is dropped
	const failing = { ...storage, setItem: () => { throw new Error('QuotaExceededError'); } };
	const store = new ConsentStore({ storage: failing });
	const seen: string[] = [];
	store.subscribe((state, origin) => { seen.push(`${state}:${origin}`); });
	assert.equal(store.state(), 'accepted');
	store.decide('rejected');
	assert.equal(store.state(), 'rejected', 'the in-memory decision wins');
	assert.deepEqual(seen, ['rejected:local']);
	assert.equal(storage.data.has(CONSENT_KEY), false, 'the stale record is removed best effort');
});

test('a failed write wins even when the stale record cannot be removed either', () => {
	const storage = fakeStorage();
	storage.data.set(CONSENT_KEY, JSON.stringify({ v: CONSENT_VERSION, choice: 'accepted', at: Date.now() }));
	const stuck = { ...storage, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
	const store = new ConsentStore({ storage: stuck });
	const seen: string[] = [];
	store.subscribe((state) => { seen.push(state); });
	store.decide('rejected');
	assert.equal(store.state(), 'rejected');
	assert.equal(store.record()?.choice, 'rejected');
	assert.deepEqual(seen, ['rejected']);
	// another tab's write later becomes the record again
	storage.data.set(CONSENT_KEY, JSON.stringify({ v: CONSENT_VERSION, choice: 'accepted', at: Date.now() }));
	store.reload();
	assert.equal(store.state(), 'accepted');
	assert.deepEqual(seen, ['rejected', 'accepted']);
});

/** Manual timers: every pending set() is listed with its delay; fire() runs the earliest one. */
function manualTimers() {
	let seq = 0;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	const timers: ConsentTimers = {
		set: (fn, ms) => { seq++; pending.set(seq, { fn, ms }); return seq; },
		clear: (handle) => { pending.delete(handle as number); },
	};
	const fire = (): void => {
		const [id, entry] = [...pending.entries()][0];
		pending.delete(id);
		entry.fn();
	};
	return { timers, pending, fire };
}

test('an expired in-memory decision reads as undecided, on the fallback and on the failed-write path', () => {
	let now = 1_000;
	// No storage: the page's memory is the only record.
	const none = new ConsentStore({ storage: null, now: () => now });
	none.decide('accepted');
	assert.equal(none.state(), 'accepted');
	now += CONSENT_TTL_MS + 1;
	assert.equal(none.state(), 'undecided', 'memory obeys the TTL like a stored record');
	// A failed write over a stale stored record: the expired memory reads undecided, never the stale record.
	now = 1_000;
	const storage = fakeStorage();
	storage.data.set(CONSENT_KEY, JSON.stringify({ v: CONSENT_VERSION, choice: 'accepted', at: now + 10 }));
	const failing = { ...storage, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('denied'); } };
	const store = new ConsentStore({ storage: failing, now: () => now });
	store.decide('rejected');
	assert.equal(store.state(), 'rejected', 'the failed write still wins over the stale record');
	now += CONSENT_TTL_MS + 1;
	assert.equal(store.state(), 'undecided');
	// A memory record of another consent version does not count either.
	const v2 = new ConsentStore({ storage: null, now: () => 5, version: 2 });
	v2.decide('accepted');
	assert.equal(v2.state(), 'accepted');
	assert.equal(new ConsentStore({ storage: null, now: () => 5 }).state(), 'undecided');
});

test('an accepted record reaching its expiry on an open page tells the listeners (origin external) without any other event', () => {
	let now = 1_000;
	const clock = manualTimers();
	const store = new ConsentStore({ storage: fakeStorage(), now: () => now, timers: clock.timers });
	const seen: string[] = [];
	store.subscribe((state, origin) => { seen.push(`${state}:${origin}`); });
	assert.equal(clock.pending.size, 0, 'nothing to expire while undecided');
	store.decide('accepted');
	assert.equal(clock.pending.size, 1, 'one check, armed for the new record');
	// The TTL is longer than setTimeout honours: the first check fires early, finds the record valid, and re-arms.
	assert.equal([...clock.pending.values()][0].ms, MAX_TIMER_MS);
	now += MAX_TIMER_MS;
	clock.fire();
	assert.deepEqual(seen, ['accepted:local'], 'still valid: no change reported');
	assert.equal(clock.pending.size, 1, 're-armed for the remainder');
	assert.equal([...clock.pending.values()][0].ms, Math.min(1_000 + CONSENT_TTL_MS + 1 - now, MAX_TIMER_MS));
	now = 1_000 + CONSENT_TTL_MS + 1;
	clock.fire();
	assert.equal(store.state(), 'undecided');
	assert.deepEqual(seen, ['accepted:local', 'undecided:external'], 'the capture mode follows the expiry');
	assert.equal(clock.pending.size, 0, 'nothing left to expire');
});

test('a withdrawal replaces the acceptance check, and the last unsubscribe cancels it', () => {
	const clock = manualTimers();
	const store = new ConsentStore({ storage: fakeStorage(), now: () => 1_000, timers: clock.timers });
	const off = store.subscribe(() => {});
	store.decide('accepted');
	const [acceptCheck] = [...clock.pending.keys()];
	store.decide('rejected');
	assert.equal(clock.pending.has(acceptCheck), false, "the acceptance's check is cleared on withdrawal");
	assert.equal(clock.pending.size, 1, "the rejection's own expiry is checked");
	off();
	assert.equal(clock.pending.size, 0, 'teardown clears it');
});

test('hasUnsavedDecision: only a decision storage does not hold', () => {
	const stored = new ConsentStore({ storage: fakeStorage(), now: () => 1 });
	assert.equal(stored.hasUnsavedDecision(), false);
	stored.decide('rejected');
	assert.equal(stored.hasUnsavedDecision(), false, 'written: the record carries it');
	const failing = new ConsentStore({ storage: { ...fakeStorage(), setItem: () => { throw new Error('QuotaExceededError'); } }, now: () => 1 });
	failing.decide('rejected');
	assert.equal(failing.hasUnsavedDecision(), true, 'the write failed');
	const none = new ConsentStore({ storage: null, now: () => 1 });
	assert.equal(none.hasUnsavedDecision(), false, 'no decision yet');
	none.decide('rejected');
	assert.equal(none.hasUnsavedDecision(), true, 'no storage to hold it');
});
