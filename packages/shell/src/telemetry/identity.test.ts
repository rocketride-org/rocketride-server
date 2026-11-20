import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Identity, type IdentityMode } from './identity.ts';

/** A fake capture mode over a consented instance whose stored identity is `userState`; every call is logged. */
function harness(opts: { consented?: boolean; userState?: string; initOk?: boolean } = {}) {
	const log: string[] = [];
	let consented = opts.consented ?? true;
	let userState = opts.userState ?? 'anonymous';
	const instance = {
		identify: (id: string) => {
			log.push(`identify:${id}`);
			userState = 'identified';
		},
		get_property: (key: string) => {
			if (key === '$user_state') {
				return userState;
			}
			return undefined;
		},
	};
	const mode: IdentityMode = {
		isConsented: () => consented,
		active: () => instance,
		setSignedIn: (signedIn: boolean) => {
			log.push(`setSignedIn:${signedIn}`);
		},
		resetIdentity: () => {
			log.push('resetIdentity');
			userState = 'anonymous';
		},
	};
	let modeReady = true;
	const identity = new Identity({
		mode: () => {
			if (modeReady) {
				return mode;
			}
			return null;
		},
		ensureInit: () => opts.initOk ?? true,
		registerAuthed: (isAuthed) => {
			log.push(`is_authed:${isAuthed}`);
		},
		markReplayResumePending: () => {
			log.push('resumePending');
		},
	});
	return {
		identity,
		log,
		accept: () => {
			consented = true;
		},
		setUserState: (s: string) => {
			userState = s;
		},
		setModeReady: (ready: boolean) => {
			modeReady = ready;
		},
	};
}

test('a sign-out drops the user id, resets an identified consented identity and asks for the replay to resume', () => {
	const h = harness();
	h.identity.setAuthed(true);
	h.identity.setIdentity('user-1');
	assert.ok(h.log.includes('identify:user-1'));
	h.log.length = 0;
	h.identity.setAuthed(false);
	assert.deepEqual(h.log, ['is_authed:false', 'setSignedIn:false', 'resetIdentity', 'resumePending']);
	assert.equal(h.identity.signedOut(), true);
	h.log.length = 0;
	h.accept();
	h.identity.identifyIfConsented();
	assert.deepEqual(h.log, [], 'the user id is gone: nothing to identify');
});

test('the first report of signed out resets a stored identified identity, and leaves an anonymous one alone', () => {
	const identified = harness({ userState: 'identified' });
	identified.identity.setAuthed(false);
	assert.deepEqual(identified.log, ['is_authed:false', 'setSignedIn:false', 'resetIdentity']);
	const anonymous = harness({ userState: 'anonymous' });
	anonymous.identity.setAuthed(false);
	assert.deepEqual(anonymous.log, ['is_authed:false', 'setSignedIn:false'], 'no reset for an anonymous identity, no replay resume');
});

test('a mid-visit accept identifies the signed-in visitor by the opaque id', () => {
	const h = harness({ consented: false });
	h.identity.setAuthed(true);
	h.identity.setIdentity('user-7');
	assert.ok(!h.log.some((l) => l.startsWith('identify:')), 'cookieless: never identified');
	h.accept();
	h.identity.identifyIfConsented(); // the consent host calls this after an acceptance
	assert.ok(h.log.includes('identify:user-7'));
});

test('a signed-in report keeps the rich capture off every time; a repeated signed-out report does not switch it again', () => {
	const h = harness();
	h.identity.setAuthed(true);
	h.identity.setAuthed(true);
	assert.equal(h.log.filter((l) => l === 'setSignedIn:true').length, 2);
	h.identity.setAuthed(false);
	h.log.length = 0;
	h.identity.setAuthed(false);
	assert.deepEqual(h.log, ['is_authed:false'], 'already signed out: no switch, no reset, no resume');
});

test('markSignedIn switches off without an init, and setAuthed(false) is what switches back on', () => {
	const h = harness({ initOk: false });
	h.identity.markSignedIn();
	assert.deepEqual(h.log, ['setSignedIn:true']);
	assert.equal(h.identity.reported, true);
	assert.equal(h.identity.signedOut(), false);
	h.identity.setAuthed(false);
	assert.equal(h.identity.signedOut(), true, 'the state is kept even when the analytics are off');
	assert.deepEqual(h.log, ['setSignedIn:true'], 'with the analytics off, nothing else is called');
});

test("the shell's sign-out always starts a fresh consented identity", () => {
	const h = harness({ userState: 'anonymous' });
	h.identity.setIdentity('user-2');
	h.log.length = 0;
	h.identity.shellSignedOut();
	assert.deepEqual(h.log, ['resetIdentity'], 'forced, whatever the stored state');
});

test('at the SDK start: identify a signed-in accepted visitor, reset a signed-out load that holds an identified identity', () => {
	const signedIn = harness();
	signedIn.setModeReady(false);
	signedIn.identity.setAuthed(true);
	signedIn.identity.setIdentity('user-3');
	assert.ok(!signedIn.log.some((l) => l.startsWith('identify:')), 'no mode yet');
	signedIn.setModeReady(true);
	signedIn.identity.sdkStarted();
	assert.ok(signedIn.log.includes('identify:user-3'));

	const signedOut = harness({ userState: 'identified' });
	signedOut.setModeReady(false);
	signedOut.identity.setAuthed(false);
	signedOut.setModeReady(true);
	signedOut.log.length = 0;
	signedOut.identity.sdkStarted();
	assert.deepEqual(signedOut.log, ['resetIdentity']);
});

test('setIdentity ignores an empty or non-string id', () => {
	const h = harness();
	h.identity.setIdentity('');
	h.identity.setIdentity(42 as unknown as string);
	assert.ok(!h.log.some((l) => l.startsWith('identify:')));
});
