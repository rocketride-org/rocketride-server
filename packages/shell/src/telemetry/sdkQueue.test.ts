import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MAX, HOLD_STORAGE_KEY, HOLD_TTL_MS, MAX_PENDING, SdkQueue, isEventUuid, newEventUuid, type HoldStorage, type SdkQueueDeps } from './sdkQueue.ts';

/** The uuid shape posthog-js@1.433.5 keeps as an explicit capture uuid (anything else is replaced). */
const POSTHOG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CaptureCall = { kind: 'capture'; event: string; props: Record<string, unknown>; options?: unknown };
type Call = CaptureCall | { kind: 'register'; props: Record<string, unknown> } | { kind: 'init' };

/** The capture calls among the recorded ones, in order. */
function captures(calls: Call[]): CaptureCall[] {
	return calls.filter((c): c is CaptureCall => {
		return c.kind === 'capture';
	});
}

/** A queue over a recording fake SDK; `initThrows` makes the init fail. */
function harness(initThrows = false) {
	const calls: Call[] = [];
	let failures = 0;
	const sdk = {
		capture: (event: string, props?: Record<string, unknown> | null, options?: unknown) => {
			calls.push({ kind: 'capture', event, props: { ...(props ?? {}) }, options });
			return undefined;
		},
		register: (props: Record<string, unknown>) => {
			calls.push({ kind: 'register', props: { ...props } });
		},
	};
	const deps: SdkQueueDeps = {
		init: () => {
			calls.push({ kind: 'init' });
			if (initThrows) {
				throw new Error('init failed');
			}
		},
		target: () => {
			return sdk;
		},
		register: (props) => {
			sdk.register(props);
		},
		onFailure: () => {
			failures++;
		},
	};
	const countFailures = (): number => {
		return failures;
	};
	return { queue: new SdkQueue(deps), calls, failures: countFailures };
}

test('captures before the start are held, then replayed in order at the start', () => {
	const { queue, calls } = harness();
	queue.capture('$pageview', { page: 'home' });
	queue.capture('section:view', { section: 'hero' });
	assert.equal(calls.length, 0, 'nothing reaches the SDK before the start');
	queue.start();
	assert.deepEqual(captures(calls).map((c) => {
		return c.event;
	}), ['$pageview', 'section:view']);
	assert.equal(calls[0].kind, 'init', 'initialised first');
});

test('a queued event carries the super properties of its own moment, and the start registers them after the replay', () => {
	const { queue, calls } = harness();
	queue.register({ app: 'home-ui', rr_traffic: 'hidden' });
	queue.capture('$pageview', { page: 'home' });
	queue.register({ is_authed: false, rr_traffic_activated: true });
	queue.capture('cta:click', { cta_id: 'hero' });
	queue.start();
	assert.deepEqual(calls, [
		{ kind: 'init' },
		{ kind: 'capture', event: '$pageview', props: { app: 'home-ui', rr_traffic: 'hidden', page: 'home' }, options: undefined },
		{ kind: 'capture', event: 'cta:click', props: { app: 'home-ui', rr_traffic: 'hidden', is_authed: false, rr_traffic_activated: true, cta_id: 'hero' }, options: undefined },
		{ kind: 'register', props: { app: 'home-ui', rr_traffic: 'hidden', is_authed: false, rr_traffic_activated: true } },
	], 'the earlier event has no is_authed or rr_traffic_activated, and nothing was registered before the replay');
});

test("an event's own property wins over a super property of the same name", () => {
	const { queue, calls } = harness();
	queue.register({ is_authed: true });
	queue.capture('cta:click', { is_authed: false });
	queue.start();
	assert.deepEqual(calls[1], { kind: 'capture', event: 'cta:click', props: { is_authed: false }, options: undefined });
});

test('after the start, captures and registrations go straight to the SDK', () => {
	const { queue, calls } = harness();
	queue.start();
	assert.equal(queue.started, true);
	queue.register({ is_authed: true });
	queue.capture('cta:click', { cta_id: 'nav' }, { transport: 'sendBeacon' });
	assert.deepEqual(calls.slice(-2), [
		{ kind: 'register', props: { is_authed: true } },
		{ kind: 'capture', event: 'cta:click', props: { cta_id: 'nav' }, options: { transport: 'sendBeacon' } },
	]);
});

test('the queue holds at most MAX_PENDING captures; later ones before the start are dropped', () => {
	const { queue, calls } = harness();
	for (let i = 0; i < MAX_PENDING + 5; i++) {
		queue.capture('section:view', { order: i });
	}
	queue.start();
	const replayed = captures(calls);
	assert.equal(replayed.length, MAX_PENDING);
	assert.equal(replayed.at(-1)?.props.order, MAX_PENDING - 1, 'the first ones are kept');
});

test('a start while the page unloads replays the queue by sendBeacon, keeping other options', () => {
	const { queue, calls } = harness();
	queue.capture('engagement', { secs: 3 });
	queue.capture('cta:click', { cta_id: 'hero' }, { transport: 'sendBeacon' });
	queue.start(true);
	assert.deepEqual(captures(calls).map((c) => {
		return c.options;
	}), [{ transport: 'sendBeacon' }, { transport: 'sendBeacon' }]);
});

test('the start runs once, whichever trigger comes first (frame, fallback timer, click, pagehide)', () => {
	const { queue, calls } = harness();
	queue.capture('$pageview', { page: 'home' });
	queue.start(); // the frame
	queue.start(); // the 500 ms fallback
	queue.start(true); // pagehide
	assert.equal(calls.filter((c) => {
		return c.kind === 'init';
	}).length, 1, 'initialised once');
	assert.equal(captures(calls).length, 1, 'replayed once');
	assert.equal(calls.filter((c) => {
		return c.kind === 'register';
	}).length, 1, 'registered once');
});

test('a failed init empties the queue, reports the failure once, and drops every later capture', () => {
	const { queue, calls, failures } = harness(true);
	queue.register({ app: 'home-ui' });
	queue.capture('$pageview', { page: 'home' });
	queue.start();
	assert.equal(failures(), 1);
	assert.equal(queue.started, false);
	queue.capture('cta:click', { cta_id: 'hero' });
	queue.register({ is_authed: true });
	queue.start();
	assert.deepEqual(calls, [{ kind: 'init' }], 'no capture or registration reached the SDK, and no second init');
	assert.equal(failures(), 1, 'reported once');
});

test('one replayed event that throws does not stop the rest of the replay', () => {
	const calls: string[] = [];
	const queue = new SdkQueue({
		init: () => {},
		target: () => {
			return {
				capture: (event: string) => {
					if (event === 'bad') {
						throw new Error('boom');
					}
					calls.push(event);
					return undefined;
				},
				register: () => {},
			};
		},
		register: () => {},
		onFailure: () => {},
	});
	queue.capture('bad', {});
	queue.capture('good', {});
	queue.start();
	assert.deepEqual(calls, ['good']);
});

// ── The sessionStorage hold (teardown survival) ─────────────────────────────

/** An in-memory Web Storage slice shared between "page loads". */
function memoryStorage(): HoldStorage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key) => {
			return map.get(key) ?? null;
		},
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

/** A harness with an injected storage + clock: `storage` persists across harnesses like a tab's sessionStorage. */
function heldHarness(storage: HoldStorage | null, now: () => number, initThrows = false) {
	const calls: Call[] = [];
	const sdk = {
		capture: (event: string, props?: Record<string, unknown> | null, options?: unknown) => {
			calls.push({ kind: 'capture', event, props: { ...(props ?? {}) }, options });
			return undefined;
		},
		register: (props: Record<string, unknown>) => {
			calls.push({ kind: 'register', props: { ...props } });
		},
	};
	const deps: SdkQueueDeps = {
		init: () => {
			calls.push({ kind: 'init' });
			if (initThrows) {
				throw new Error('init failed');
			}
		},
		target: () => {
			return sdk;
		},
		register: (props) => {
			sdk.register(props);
		},
		onFailure: () => {},
		storage,
		now,
	};
	return { queue: new SdkQueue(deps), calls };
}

test('a capture is mirrored AT ENQUEUE: a torn-down page leaves it in storage for the next load', () => {
	const storage = memoryStorage();
	const first = heldHarness(storage, () => 1_000_000);
	first.queue.capture('cta:click', { intent: 'register' });
	// The page is torn down here (OAuth redirect): start() never runs on this load.
	const raw = storage.getItem(HOLD_STORAGE_KEY);
	assert.ok(raw, 'the mirror was written at enqueue, not at teardown');
	assert.equal((JSON.parse(raw as string) as unknown[]).length, 1);
});

test('the next page load drains the inherited hold with original timestamps and the fact id as uuid, then clears it', () => {
	const storage = memoryStorage();
	const first = heldHarness(storage, () => 1_000_000);
	first.queue.capture('cta:click', { intent: 'register' });
	// Next load, two minutes later: the inherited entry replays FIRST, back-dated and dedupable.
	const second = heldHarness(storage, () => 1_120_000);
	second.queue.capture('$pageview', { path: '/auth' });
	second.queue.start();
	const sent = captures(second.calls);
	assert.equal(sent.length, 2);
	assert.equal(sent[0].event, 'cta:click');
	const options = sent[0].options as { timestamp?: Date; uuid?: string };
	assert.equal(options.timestamp?.getTime(), 1_000_000, 'original time, not the drain time');
	assert.match(options.uuid ?? '', POSTHOG_UUID, 'the fact id rides as the event uuid in the shape posthog-js keeps, so a replay dedupes');
	assert.equal(sent[1].event, '$pageview');
	assert.equal((sent[1].options as undefined | object), undefined, 'this load\'s own replay keeps start-time semantics');
	assert.equal(storage.getItem(HOLD_STORAGE_KEY), null, 'cleared after the drain (capture first, clear after)');
});

test('an inherited entry past the TTL is discarded at drain, not replayed', () => {
	const storage = memoryStorage();
	const first = heldHarness(storage, () => 1_000_000);
	first.queue.capture('cta:click', {});
	const second = heldHarness(storage, () => 1_000_000 + HOLD_TTL_MS + 1);
	second.queue.start();
	assert.deepEqual(captures(second.calls), []);
});

test('a corrupt mirror reads as empty and never throws', () => {
	const storage = memoryStorage();
	storage.setItem(HOLD_STORAGE_KEY, '{not json');
	const h = heldHarness(storage, () => 1_000_000);
	h.queue.start();
	assert.deepEqual(captures(h.calls), []);
});

test('the hold is bounded: oldest entries are dropped first beyond HOLD_MAX', () => {
	const storage = memoryStorage();
	const h = heldHarness(storage, () => 1_000_000);
	for (let i = 0; i < HOLD_MAX + 5; i++) {
		h.queue.capture(`e${i}`, {});
	}
	const held = JSON.parse(storage.getItem(HOLD_STORAGE_KEY) as string) as Array<{ event: string }>;
	assert.equal(held.length, HOLD_MAX);
	assert.equal(held[0].event, 'e5', 'the oldest were dropped first');
});

test('clearHold drops the hold and its mirror without delivering (sign-out)', () => {
	const storage = memoryStorage();
	const first = heldHarness(storage, () => 1_000_000);
	first.queue.capture('cta:click', {});
	const second = heldHarness(storage, () => 1_010_000);
	second.queue.clearHold();
	second.queue.start();
	assert.deepEqual(captures(second.calls), []);
	assert.equal(storage.getItem(HOLD_STORAGE_KEY), null);
});

test("clearHold before the start also drops this load's pending captures: a sign-out never replays them at the start", () => {
	const h = heldHarness(memoryStorage(), () => 1_000_000);
	h.queue.capture('cta:click', {});
	h.queue.capture('$pageview', {});
	assert.equal(h.queue.peekPending().length, 2);
	h.queue.clearHold();
	assert.deepEqual(h.queue.peekPending(), []);
	h.queue.start();
	assert.deepEqual(captures(h.calls), []);
});

test('a failed init clears the mirror: a stale hold must not outlive a load with telemetry off', () => {
	const storage = memoryStorage();
	const first = heldHarness(storage, () => 1_000_000);
	first.queue.capture('cta:click', {});
	const second = heldHarness(storage, () => 1_010_000, true);
	second.queue.start();
	assert.equal(storage.getItem(HOLD_STORAGE_KEY), null);
});

test('a legacy non-uuid id in the inherited hold is normalized once at hydrate: every replay of it carries the same uuid', () => {
	const storage = memoryStorage();
	storage.setItem(HOLD_STORAGE_KEY, JSON.stringify([
		{ event: 'cta:click', props: {}, ts: 1_000_000, id: 'lfls-h0' },
		{ event: 'cta:view', props: {}, ts: 1_000_000 },
	]));
	heldHarness(storage, () => 1_010_000); // hydrates and rewrites the mirror
	const rewritten = JSON.parse(storage.getItem(HOLD_STORAGE_KEY) as string) as Array<{ id: string }>;
	assert.equal(rewritten.length, 2);
	for (const entry of rewritten) {
		assert.match(entry.id, POSTHOG_UUID, 'the hydrated mirror was rewritten with uuid ids');
	}
	// A load that crashes before clearing re-reads the SAME normalized ids: no fresh mint per load.
	const third = heldHarness(storage, () => 1_020_000);
	third.queue.start();
	const sent = captures(third.calls).map((c) => (c.options as { uuid?: string }).uuid);
	assert.deepEqual(sent, rewritten.map((e) => e.id));
});

test('a uuid-shaped inherited id is kept as is', () => {
	const storage = memoryStorage();
	const id = '123e4567-e89b-42d3-a456-426614174000';
	storage.setItem(HOLD_STORAGE_KEY, JSON.stringify([{ event: 'cta:click', props: {}, ts: 1_000_000, id }]));
	const h = heldHarness(storage, () => 1_010_000);
	h.queue.start();
	assert.equal((captures(h.calls)[0].options as { uuid?: string }).uuid, id);
});

test('newEventUuid: randomUUID, else getRandomValues, else Math.random; always a v4 posthog-js keeps', () => {
	assert.equal(newEventUuid({ randomUUID: () => '123E4567-E89B-42D3-A456-426614174000' }), '123e4567-e89b-42d3-a456-426614174000');
	const fromBytes = newEventUuid({ randomUUID: () => { throw new Error('insecure context'); }, getRandomValues: (a) => a.fill(0xff) });
	assert.equal(fromBytes, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
	for (const id of [newEventUuid(null), newEventUuid({ randomUUID: () => 'not-a-uuid' }), newEventUuid()]) {
		assert.match(id, POSTHOG_UUID);
		assert.match(id, /^.{14}4.{4}[89ab]/i, 'version 4, RFC 4122 variant');
		assert.ok(isEventUuid(id));
	}
	assert.equal(isEventUuid('lfls-h0'), false);
});
