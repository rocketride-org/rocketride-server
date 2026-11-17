// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Identity, type IdentityMode } from './identity.ts';
import { clearTelemetryOnSignOut, getReporter, initTelemetryHost, knownSignedOutForTests, loadTransportForTests, markTelemetrySignedIn, resetTelemetryHostForTests, setPageActive, setTelemetryIdentity, shellReporter, telemetryAppStamp } from './host.ts';
import { HOLD_STORAGE_KEY } from './sdkQueue.ts';
import { resetDevGateForTests } from '../util/devGate.ts';

/** Run `fn` with the given globals installed, restoring the originals after. */
async function withGlobals(globals: Record<string, unknown>, fn: () => void | Promise<void>): Promise<void> {
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
	resetDevGateForTests();
	try {
		await fn();
	} finally {
		resetDevGateForTests();
		for (const [key, original] of originals) {
			if (original) Object.defineProperty(globalThis, key, original);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
}

/** A sessionStorage double over a Map that records every removal. */
function session(initial: Array<[string, string]> = []) {
	const data = new Map<string, string>(initial);
	const removed: string[] = [];
	return {
		data,
		removed,
		storage: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => { data.set(k, v); },
			removeItem: (k: string) => { removed.push(k); data.delete(k); },
		},
	};
}

/** A top-level page with manual timers, so the SDK start runs exactly when the test says. */
function page(extra: Record<string, unknown> = {}) {
	const timers: Array<() => void> = [];
	const win: Record<string, unknown> = {
		location: { search: '', pathname: '/', hostname: 'cloud.example.test' },
		setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
		addEventListener: () => {},
		innerWidth: 1280,
		innerHeight: 800,
		...extra,
	};
	win.self = win;
	win.top = win;
	const runTimers = (): void => {
		while (timers.length) timers.shift()?.();
	};
	return { win, runTimers };
}

/**
 * A fake transport chunk over a REAL Identity whose capture mode exists only
 * once init ran (as in transport.ts). The consented instance's stored identity
 * starts as `userState`; every identity and lifecycle call is logged in order.
 */
function fakeTransport(userState: string) {
	const log: string[] = [];
	let state = userState;
	let started = false;
	const mode: IdentityMode = {
		isConsented: () => true,
		active: () => ({
			identify: (id: string) => { log.push(`identify:${id}`); state = 'identified'; },
			get_property: (key: string) => (key === '$user_state' ? state : undefined),
		}),
		setSignedIn: (signedIn: boolean) => { log.push(`setSignedIn:${signedIn}`); },
		resetIdentity: () => { log.push('resetIdentity'); state = 'anonymous'; },
	};
	class LoggedIdentity extends Identity {
		override setAuthed(isAuthed: boolean): void { log.push(`setAuthed:${isAuthed}`); super.setAuthed(isAuthed); }
		override setIdentity(id: string | null): void { log.push(`setIdentity:${id}`); super.setIdentity(id); }
	}
	const identity = new LoggedIdentity({
		mode: () => (started ? mode : null),
		ensureInit: () => true,
		registerAuthed: () => {},
		markReplayResumePending: () => {},
	});
	const sdk = { capture: () => {}, register: () => {} };
	const module = {
		bindTransport: () => { log.push('bind'); },
		transportIdentity: () => identity,
		startWebVitals: () => {},
		initPostHog: () => { log.push('init'); started = true; identity.sdkStarted(); },
		active: () => sdk,
		registerOnInstances: () => {},
		syncPageActive: (active: boolean) => { log.push(`syncPageActive:${active}`); },
	};
	return { log, module: module as unknown as Parameters<typeof loadTransportForTests>[0] };
}

const docHidden = { visibilityState: 'hidden' };

test('a signed-in identity resolved before the chunk binds is replayed before the SDK starts, so the user is identified', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		setTelemetryIdentity(true, 'u1'); // bootstrap resolved first; no transport yet
		assert.equal(knownSignedOutForTests(), false);
		const t = fakeTransport('anonymous');
		loadTransportForTests(t.module);
		runTimers();
		assert.deepEqual(t.log, ['bind', 'setAuthed:true', 'setIdentity:u1', 'init', 'identify:u1'], 'replayed after bind and before init; identified at start');
	});
});

test('a signed-out identity resolved before the chunk binds is replayed: the surface is known signed out and a stored identified identity is dropped', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		setTelemetryIdentity(false, null);
		assert.equal(knownSignedOutForTests(), true);
		const t = fakeTransport('identified');
		loadTransportForTests(t.module);
		runTimers();
		assert.deepEqual(t.log, ['bind', 'setAuthed:false', 'setIdentity:null', 'init', 'resetIdentity']);
	});
});

test('a signed-in reload whose bootstrap is still running at bind replays nothing and never wipes the stored identity', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		assert.equal(knownSignedOutForTests(), false, 'unknown is not signed out');
		const t = fakeTransport('identified');
		loadTransportForTests(t.module);
		runTimers();
		assert.deepEqual(t.log, ['bind', 'init'], 'no replay, no reset at the SDK start');
		setTelemetryIdentity(true, 'u1'); // the bootstrap resolves after the start
		assert.ok(!t.log.includes('resetIdentity'), 'the stored identified identity survives the reload');
		assert.ok(t.log.includes('identify:u1'));
	});
});

test('a sign-in marked before the chunk binds is replayed as signed in, keeping the known user id', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		setTelemetryIdentity(false, null);
		markTelemetrySignedIn();
		assert.equal(knownSignedOutForTests(), false);
		const t = fakeTransport('anonymous');
		loadTransportForTests(t.module);
		runTimers();
		assert.deepEqual(t.log.slice(0, 3), ['bind', 'setAuthed:true', 'setIdentity:null']);
		assert.ok(!t.log.includes('resetIdentity'));
	});
});

test('after the bind, identity reports go straight to the transport', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		const t = fakeTransport('anonymous');
		loadTransportForTests(t.module);
		runTimers();
		setTelemetryIdentity(true, 'u2');
		assert.deepEqual(t.log.slice(-4), ['setAuthed:true', 'setSignedIn:true', 'setIdentity:u2', 'identify:u2']);
		clearTelemetryOnSignOut();
		setTelemetryIdentity(false, null);
		assert.equal(knownSignedOutForTests(), true);
	});
});

test('the app stamp is the descriptor telemetryId when set, else the descriptor id', () => {
	assert.equal(telemetryAppStamp('rocketride.home', 'home-ui'), 'home-ui');
	assert.equal(telemetryAppStamp('rocketride.home'), 'rocketride.home');
	assert.equal(telemetryAppStamp('rocketride.home', undefined), 'rocketride.home');
	// A malformed alias never reaches the stamp: it falls back to the id.
	for (const bad of ['', 'has space', 'x'.repeat(129), 42, null]) {
		assert.equal(telemetryAppStamp('rocketride.home', bad), 'rocketride.home', `bad alias ${String(bad)}`);
	}
});

test('a reporter bound to a telemetryId stamps it, and per-event props cannot overwrite it; auth facts still stamp shell', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		const t = fakeTransport('anonymous');
		const captured: Array<[string, Record<string, unknown>]> = [];
		const sdk = { capture: (event: string, props: Record<string, unknown>) => { captured.push([event, props]); }, register: () => {} };
		(t.module as unknown as { active: () => typeof sdk }).active = () => sdk;
		loadTransportForTests(t.module);
		runTimers();
		getReporter(telemetryAppStamp('rocketride.home', 'home-ui'))('chat:send', { app: 'spoofed', n: 1 });
		getReporter(telemetryAppStamp('rocketride.models'))('models:open', { app: 'spoofed' });
		shellReporter()('auth:complete', { app: 'home-ui', source: 'shell' });
		assert.deepEqual(captured.map(([event, props]) => [event, props.app]), [
			['chat:send', 'home-ui'],
			['models:open', 'rocketride.models'],
			['auth:complete', 'shell'],
		]);
		assert.equal(captured[0][1].n, 1, 'the caller props still ride along');
	});
});

test('a page-active change after the SDK start is pushed to the live instances', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		const t = fakeTransport('anonymous');
		loadTransportForTests(t.module);
		runTimers();
		setPageActive(true);
		setPageActive(false);
		assert.deepEqual(t.log.filter((entry) => entry.startsWith('syncPageActive')), ['syncPageActive:true', 'syncPageActive:false']);
	});
});

test('an unchanged page-active value, or one set before the SDK start, pushes nothing', async () => {
	const { win, runTimers } = page();
	await withGlobals({ window: win, document: docHidden }, () => {
		resetTelemetryHostForTests();
		const t = fakeTransport('anonymous');
		loadTransportForTests(t.module);
		setPageActive(true); // before the start: the init reads it through isPage()
		runTimers();
		setPageActive(true); // unchanged after the start
		assert.deepEqual(t.log.filter((entry) => entry.startsWith('syncPageActive')), []);
	});
});

const heldEntry = (): Array<[string, string]> => [[HOLD_STORAGE_KEY, JSON.stringify([{ event: 'auth:start', props: {}, ts: Date.now(), id: 'h1' }])]];

test('every disabled branch drops the hold an earlier page load of the tab left', async () => {
	const cases: Array<[string, Record<string, unknown>, { key: string; host: string; consentSource: 'stored' | 'host' }]> = [
		['no key', {}, { key: '', host: '', consentSource: 'stored' }],
		['GPC', { navigator: { globalPrivacyControl: true } }, { key: 'phc_x', host: 'https://e.example.test', consentSource: 'stored' }],
		['DNT', { navigator: { doNotTrack: '1' } }, { key: 'phc_x', host: 'https://e.example.test', consentSource: 'stored' }],
		['host consent', { navigator: {} }, { key: 'phc_x', host: 'https://e.example.test', consentSource: 'host' }],
	];
	for (const [label, globals, config] of cases) {
		const tab = session(heldEntry());
		const { win } = page();
		await withGlobals({ window: win, document: docHidden, sessionStorage: tab.storage, ...globals }, () => {
			resetTelemetryHostForTests(); // the queue inherits the hold, as on a fresh page load
			initTelemetryHost(config);
			assert.equal(tab.data.has(HOLD_STORAGE_KEY), false, `${label}: hold dropped`);
		});
	}
});

/** A full Storage double (key/length too, as clearPostHogStorage enumerates) over a Map. */
function store(keys: string[]) {
	const data = new Map<string, string>(keys.map((k) => [k, '1']));
	return {
		data,
		storage: {
			get length() { return data.size; },
			key: (i: number) => [...data.keys()][i] ?? null,
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => { data.set(k, v); },
			removeItem: (k: string) => { data.delete(k); },
		},
	};
}

/** A document double whose cookie setter applies expiries, as a browser's would. */
function cookieDoc(initial: string[]) {
	const jar = new Map<string, string>(initial.map((c) => c.split('=') as [string, string]));
	return {
		jar,
		doc: {
			visibilityState: 'hidden',
			get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
			set cookie(value: string) {
				const [pair] = value.split(';');
				const [name, v] = pair.split('=');
				if (/expires=Thu, 01 Jan 1970|max-age=0/i.test(value)) jar.delete(name.trim());
				else jar.set(name.trim(), v);
			},
		},
	};
}

const PH_LOCAL = ['ph_phc_x_posthog', '__ph_opt_in_out_phc_x', '_postHogToolbarParams'];
const PH_SESSION = ['ph_phc_x_window_id', 'ph_phc_x_primary_window_exists'];

/** Boot the host with prior-visit PostHog storage under `nav`, and return what is left. */
async function bootWithStoredPostHog(nav: Record<string, unknown>, consentSource: 'stored' | 'host' = 'stored') {
	const local = store([...PH_LOCAL, 'rr_consent_v1']);
	const tab = store([...PH_SESSION, 'rr:auth:start_ts']);
	const { jar, doc } = cookieDoc(['ph_phc_x_posthog=abc', 'other=1']);
	const { win } = page({ localStorage: local.storage, sessionStorage: tab.storage });
	await withGlobals({ window: win, document: doc, sessionStorage: tab.storage, localStorage: local.storage, navigator: nav }, () => {
		resetTelemetryHostForTests();
		initTelemetryHost({ key: 'phc_x', host: 'https://e.example.test', consentSource });
	});
	return { local: [...local.data.keys()], session: [...tab.data.keys()], cookies: [...jar.keys()] };
}

for (const [label, nav] of [['DNT', { doNotTrack: '1' }], ['GPC', { globalPrivacyControl: true }]] as const) {
	test(`a ${label} signal removes PostHog's stored keys and ph_ cookies from an earlier visit, and nothing else`, async () => {
		const left = await bootWithStoredPostHog(nav);
		assert.deepEqual(left.local, ['rr_consent_v1']);
		assert.deepEqual(left.session, ['rr:auth:start_ts']);
		assert.deepEqual(left.cookies, ['other']);
	});
}

test('without a privacy signal a disabled boot leaves PostHog storage alone', async () => {
	// the host-consent branch: disabled at boot like the signal branch, but no signal
	const left = await bootWithStoredPostHog({}, 'host');
	assert.deepEqual(left.local, [...PH_LOCAL, 'rr_consent_v1']);
	assert.deepEqual(left.session, [...PH_SESSION, 'rr:auth:start_ts']);
	assert.deepEqual(left.cookies, ['ph_phc_x_posthog', 'other']);
});

test('a privacy-signal boot never throws when every storage accessor throws', async () => {
	const { win } = page();
	const boom = () => { throw new Error('SecurityError'); };
	Object.defineProperty(win, 'localStorage', { get: boom });
	Object.defineProperty(win, 'sessionStorage', { get: boom });
	const doc = { visibilityState: 'hidden', get cookie(): string { return boom(); } };
	await withGlobals({ window: win, document: doc, navigator: { globalPrivacyControl: true } }, () => {
		resetTelemetryHostForTests();
		assert.doesNotThrow(() => initTelemetryHost({ key: 'phc_x', host: 'https://e.example.test', consentSource: 'stored' }));
	});
});

test("an embedded preview's disabled boot never touches the host tab's hold", async () => {
	const tab = session(heldEntry());
	const win: Record<string, unknown> = { location: { search: '?rrdev=1', pathname: '/', hostname: 'cloud.example.test' }, self: {}, top: {} };
	await withGlobals({ window: win, document: docHidden, sessionStorage: tab.storage }, () => {
		resetTelemetryHostForTests(); // the preview's queue is memory-only
		initTelemetryHost({ key: '', host: '', consentSource: 'stored' });
		assert.deepEqual(tab.removed, [], 'nothing removed from the shared sessionStorage');
		assert.equal(tab.data.has(HOLD_STORAGE_KEY), true);
	});
});
