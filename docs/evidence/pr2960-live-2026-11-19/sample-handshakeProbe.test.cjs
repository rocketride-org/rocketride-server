// Tests the actual disposable controller with deterministic Window/timer doubles.
// No browser, real credentials, actual messages, or product policy replacements.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('/Users/nihalnihalani/Desktop/Github/rr-worktrees/pr2960-live-20261119/node_modules/typescript');
const helper = path.join(__dirname, 'sample-handshakeProbe.ts');
assert.equal(fs.readFileSync(helper, 'utf8'), fs.readFileSync('/private/tmp/rr2960-sample/apps/rr2960-ui/src/handshakeProbe.ts', 'utf8'));
const compiled = ts.transpileModule(fs.readFileSync(helper, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObject = { exports: {} };
new Function('exports', 'module', compiled)(moduleObject.exports, moduleObject);
const { getHandshakeProbe } = moduleObject.exports;

function fixture() {
	let now = 0, nextTimer = 1;
	const timers = new Map(), timeouts = [], updates = [], sent = [];
	const listeners = new Map(), openerListeners = new Map();
	const add = (map, type, callback) => { const entries = map.get(type) || new Set(); entries.add(callback); map.set(type, entries); };
	const remove = (map, type, callback) => { map.get(type)?.delete(callback); };
	const dispatch = (map, data, source, origin = 'http://localhost:5565') => { for (const callback of [...(map.get('message') || [])]) callback({ data, source, origin }); };
	const opener = { closed: false, addEventListener: (type, callback) => add(openerListeners, type, callback), removeEventListener: (type, callback) => remove(openerListeners, type, callback) };
	const schedule = (callback, delay, interval) => { const id = nextTimer++; timers.set(id, { callback, at: now + delay, interval }); if (!interval) timeouts.push(callback); return id; };
	const target = {
		opener, closed: false, location: { origin: 'http://localhost:5565' }, performance: { now: () => now, timeOrigin: 100000 },
		addEventListener: (type, callback) => add(listeners, type, callback), removeEventListener: (type, callback) => remove(listeners, type, callback),
		setTimeout: (callback, delay) => schedule(callback, delay, 0), clearTimeout: (id) => timers.delete(id),
		setInterval: (callback, delay) => schedule(callback, delay, delay), clearInterval: (id) => timers.delete(id),
		Function: () => (attemptId) => { sent.push(attemptId); },
	};
	const controller = getHandshakeProbe(target);
	const unsubscribe = controller.subscribe((record) => updates.push(record));
	return {
		target, opener, controller, unsubscribe, updates, sent, timers, timeouts,
		last: () => updates.at(-1),
		auth: (source = opener, origin = target.location.origin, token = 'TEST_VALUE_MUST_NOT_BE_RETAINED') => dispatch(listeners, { type: 'rrdev:auth', token }, source, origin),
		ready: (tag = sent.at(-1), source = target, origin = target.location.origin) => dispatch(openerListeners, { type: 'shell:devReady', rr2960ProbeAttempt: tag }, source, origin),
		pagehide: () => { for (const callback of [...(listeners.get('pagehide') || [])]) callback({}); },
		listenerCount: () => [...listeners.values(), ...openerListeners.values()].reduce((n, entries) => n + entries.size, 0),
		advance: (ms) => {
			const end = now + ms;
			for (let loops = 0; loops < 10000; loops++) {
				const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) { now = end; return; }
				const [id, timer] = next; now = timer.at;
				if (timer.interval) timer.at += timer.interval; else timers.delete(id);
				timer.callback();
			}
			throw new Error('Fake timer loop overflow');
		},
	};
}

test('construction and elapsed idle time never send or install listeners', () => {
	const f = fixture(); f.advance(6000);
	assert.equal(f.sent.length, 0); assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0); assert.equal(f.last().status, 'IDLE');
});

test('a queued old timeout cannot overwrite the second attempt', () => {
	const f = fixture(); f.controller.start(); const old = f.timeouts[0]; const oldId = f.last().attemptId;
	f.advance(4900); f.controller.start(); const newId = f.last().attemptId;
	assert.notEqual(oldId, newId); assert.equal(f.last().attempt, 2); old();
	assert.equal(f.last().attemptId, newId); assert.equal(f.last().status, 'WAITING'); assert.equal(f.last().elapsedMs, 0);
	f.advance(4999); assert.equal(f.last().status, 'WAITING'); f.advance(1);
	assert.equal(f.last().status, 'TIMEOUT'); assert.equal(f.last().elapsedMs, 5000); assert.equal(f.listenerCount(), 0);
});

test('waiting exposes monotonic elapsed time and send return', () => {
	const f = fixture(); f.controller.start(); f.advance(1200);
	assert.equal(f.last().status, 'WAITING'); assert.equal(f.last().elapsedMs, 1200); assert.equal(f.last().sendReturned, true);
	assert.equal(f.last().openerPresent, true); assert.equal(f.last().openerClosed, false); f.unsubscribe(); f.advance(5000);
});

test('only tagged ready messages are observed; trusted auth reply is recorded without a token value', () => {
	const f = fixture(); f.controller.start(); f.ready('unrelated-tag'); assert.equal(f.last().readySeen, false);
	f.advance(250); f.ready(); f.auth();
	assert.equal(f.last().status, 'REPLY_OBSERVED'); assert.equal(f.last().readySeen, true); assert.equal(f.last().readySourceIsDebug, true); assert.equal(f.last().readyOriginMatches, true);
	assert.equal(f.last().authSourceIsOpener, true); assert.equal(f.last().authOriginMatches, true); assert.equal(f.last().tokenPresent, true);
	assert.equal(JSON.stringify(f.target.__rr2960ProbeLastResult).includes('TEST_VALUE_MUST_NOT_BE_RETAINED'), false);
	f.advance(6000); assert.equal(f.last().status, 'REPLY_OBSERVED'); assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0);
});

test('wrong-source and wrong-origin auth do not complete the attempt', () => {
	const f = fixture(); f.controller.start(); f.auth({}); assert.equal(f.last().status, 'WAITING'); assert.equal(f.last().authSourceIsOpener, false);
	f.auth(f.opener, 'https://foreign.example'); assert.equal(f.last().status, 'WAITING'); assert.equal(f.last().authOriginMatches, false);
	f.advance(5000); assert.equal(f.last().status, 'TIMEOUT'); assert.equal(f.last().authSeen, true);
});

test('a sender exception is explicit and cancels the timer and listeners', () => {
	const f = fixture(); f.target.Function = () => { const error = new Error('unsafe error message must not persist'); error.name = 'EvalError'; throw error; };
	f.controller.start(); assert.equal(f.last().status, 'SEND_ERROR'); assert.equal(f.last().errorClass, 'EvalError'); assert.equal(f.last().sendReturned, false);
	assert.equal(JSON.stringify(f.last()).includes('unsafe error message'), false); assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0);
	f.advance(6000); assert.equal(f.last().status, 'SEND_ERROR');
});

test('missing and closed opener are distinguished without a send', () => {
	const missing = fixture(); missing.target.opener = null; missing.controller.start(); assert.equal(missing.last().status, 'NO_OPENER'); assert.equal(missing.last().openerPresent, false); assert.equal(missing.sent.length, 0);
	const closed = fixture(); closed.opener.closed = true; closed.controller.start(); assert.equal(closed.last().status, 'OPENER_CLOSED'); assert.equal(closed.last().openerClosed, true); assert.equal(closed.sent.length, 0);
});

test('a reply during the React subscriber gap survives and is shown on remount', () => {
	const f = fixture(); f.controller.start(); f.advance(12); f.ready(); f.unsubscribe(); const oldUpdateCount = f.updates.length;
	f.advance(8); f.auth(); assert.equal(f.updates.length, oldUpdateCount);
	assert.equal(f.controller.getSnapshot().status, 'REPLY_OBSERVED'); assert.equal(f.controller.getSnapshot().elapsedMs, 20);
	let restored; const same = getHandshakeProbe(f.target); assert.equal(same, f.controller);
	const detach = same.subscribe((record) => { restored = record; }); assert.equal(restored.status, 'REPLY_OBSERVED'); assert.equal(restored.readySeen, true); assert.equal(restored.tokenPresent, true);
	assert.equal(f.sent.length, 1); assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0); detach();
});

test('completed reply metadata survives a component remount without replaying the handshake', () => {
	const f = fixture(); f.controller.start(); f.auth(); f.unsubscribe(); let restored;
	const next = getHandshakeProbe(f.target); const detach = next.subscribe((record) => { restored = record; }); assert.equal(restored.status, 'REPLY_OBSERVED'); assert.equal(restored.tokenPresent, true); assert.equal(f.sent.length, 1); detach();
});

test('timeout cleans every message, pagehide and timer resource even without a subscriber', () => {
	const f = fixture(); f.controller.start(); f.unsubscribe(); const oldUpdateCount = f.updates.length; f.advance(5000);
	assert.equal(f.updates.length, oldUpdateCount); assert.equal(f.controller.getSnapshot().status, 'TIMEOUT'); assert.equal(f.controller.getSnapshot().elapsedMs, 5000);
	assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0); assert.equal(getHandshakeProbe(f.target), f.controller); assert.equal(f.sent.length, 1);
});

test('StrictMode-style unsubscribe/resubscribe and module re-evaluation reuse one target controller', () => {
	const f = fixture(); f.unsubscribe(); f.unsubscribe(); let notifications = 0;
	const listener = () => { notifications++; }; const detachA = f.controller.subscribe(listener); const detachB = f.controller.subscribe(listener);
	const before = notifications; detachA(); f.controller.start(); assert.equal(notifications - before, 2); assert.equal(f.sent.length, 1);
	const reevaluated = { exports: {} }; new Function('exports', 'module', compiled)(reevaluated.exports, reevaluated);
	assert.equal(reevaluated.exports.getHandshakeProbe(f.target), f.controller); detachB(); const after = notifications; f.auth(); assert.equal(notifications, after);
});

test('a controller copied onto another target is not reused for that window', () => {
	const first = fixture(), second = fixture(); second.unsubscribe(); second.target.__rr2960ProbeController = first.controller;
	const other = getHandshakeProbe(second.target); assert.notEqual(other, first.controller); assert.equal(other.isForTarget(second.target), true); assert.equal(other.isForTarget(first.target), false);
	assert.equal(first.sent.length, 0); assert.equal(second.sent.length, 0); assert.equal(other.getSnapshot().status, 'IDLE');
});

test('real document pagehide interrupts active work without sending or waiting for React', () => {
	const f = fixture(); f.controller.start(); f.advance(25); f.pagehide();
	assert.equal(f.controller.getSnapshot().status, 'INTERRUPTED'); assert.equal(f.controller.getSnapshot().interruption, 'document'); assert.equal(f.controller.getSnapshot().elapsedMs, 25);
	assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1);
});

test('closed opener and closed target clean active work on the bounded ticker', () => {
	const opener = fixture(); opener.controller.start(); opener.opener.closed = true; opener.advance(100);
	assert.equal(opener.controller.getSnapshot().status, 'OPENER_CLOSED'); assert.equal(opener.listenerCount(), 0); assert.equal(opener.timers.size, 0);
	const target = fixture(); target.controller.start(); target.target.closed = true; target.advance(100);
	assert.equal(target.controller.getSnapshot().status, 'INTERRUPTED'); assert.equal(target.controller.getSnapshot().interruption, 'document'); assert.equal(target.listenerCount(), 0); assert.equal(target.timers.size, 0);
});

test('a prematurely invoked current timer is labeled TIMER_EARLY instead of a five-second timeout', () => {
	const f = fixture(); f.controller.start(); f.timeouts[0](); assert.equal(f.last().status, 'TIMER_EARLY'); assert.equal(f.last().elapsedMs, 0); assert.equal(f.listenerCount(), 0);
});
