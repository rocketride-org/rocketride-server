import { test } from 'node:test';
// (reload: another tab's storage write)
import assert from 'node:assert/strict';
import { ConsentStore, parseConsent, CONSENT_KEY, CONSENT_TTL_MS, CONSENT_VERSION } from './consent.ts';

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
