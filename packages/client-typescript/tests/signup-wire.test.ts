import { afterEach, it as test, jest } from '@jest/globals';
import assert from 'node:assert/strict';
import { RocketRideClient } from '../src/client/client';
import { TransportWebSocket } from '../src/client/core/TransportWebSocket';
import { normalizeSignupProperties } from '../src/client/index';
import type { PkceCredential, SignupProperties } from '../src/client/types/signup';
import type { connectionManager, ShellEventMap } from '../src/app-sdk';

const EXPOSURE_LIFETIME_MS = 30 * 60 * 1000;
const credential: PkceCredential = {
	code: 'test-code',
	verifier: 'test-verifier',
	redirectUri: 'https://example.invalid',
};

function signupContext(): SignupProperties {
	const exposedAt = Date.now();
	return {
		schema_version: 1,
		experiment: 'homepage-roulette-r1',
		experiment_revision: 'r1',
		variant_id: 'mh-1',
		assignment_id: '11111111-1111-4111-8111-111111111111',
		exposure_id: '22222222-2222-4222-8222-222222222222',
		landing_message_revision: '0123456789abcdef',
		exposed_at: exposedAt,
		expires_at: exposedAt + EXPOSURE_LIFETIME_MS,
		consent_version: 1,
	};
}

afterEach(() => {
	jest.restoreAllMocks();
});

/** Exercise the public lifecycle; replace only transport I/O and capture the auth request. */
async function captureAuth(method: 'login' | 'connect', pkce: PkceCredential, beforeReady?: () => void): Promise<string> {
	jest.spyOn(TransportWebSocket.prototype, 'connect').mockImplementation(async () => {
		beforeReady?.();
	});
	jest.spyOn(TransportWebSocket.prototype, 'disconnect').mockResolvedValue();
	const client = new RocketRideClient({ env: {}, persist: false });
	let auth: unknown;
	jest.spyOn(client, 'request').mockImplementation(async (request) => {
		assert.equal(request.command, 'auth');
		auth = request.arguments?.auth;
		return { type: 'response', command: 'auth', seq: 1, request_seq: 0, success: true, body: { userToken: 'test-token' } };
	});
	try {
		await client[method](pkce);
		assert.equal(typeof auth, 'string');
		return String(auth);
	} finally {
		await client.detach();
	}
}

for (const method of ['login', 'connect'] as const) {
	test(`${method} defers a throwing signup getter until transport readiness and still authenticates`, async () => {
		let getterCalls = 0;
		const hostileCredential: PkceCredential = {
			...credential,
			get signupProperties(): SignupProperties {
				getterCalls++;
				throw new Error('optional getter unavailable');
			},
		};
		const wire = await captureAuth(method, hostileCredential, () => {
			assert.equal(getterCalls, 0, 'do not read optional getters while snapshotting credentials');
		});
		assert.equal(getterCalls, 1);
		assert.equal(wire, 'cd_' + btoa(JSON.stringify(credential)));
	});

	test(`${method} snapshots only required credentials without enumerating a caller proxy`, async () => {
		const signup = signupContext();
		const input: PkceCredential = { ...credential, signupProperties: signup };
		const proxy = new Proxy(input, {
			ownKeys: () => {
				throw new Error('do not enumerate credentials');
			},
		});
		const wire = await captureAuth(method, proxy, () => {
			input.code = 'changed-after-login';
		});
		assert.deepEqual(JSON.parse(atob(wire.slice(3))), { ...credential, signup_properties: signup });
	});

	test(`${method} preserves validated signup attribution in the auth credential`, async () => {
		const signup = signupContext();
		const wire = await captureAuth(method, { ...credential, signupProperties: signup });
		assert.deepEqual(JSON.parse(atob(wire.slice(3))), { ...credential, signup_properties: signup });
	});

	test(`${method} preserves exact legacy bytes when context is absent or malformed`, async () => {
		const expected = 'cd_eyJjb2RlIjoidGVzdC1jb2RlIiwidmVyaWZpZXIiOiJ0ZXN0LXZlcmlmaWVyIiwicmVkaXJlY3RVcmkiOiJodHRwczovL2V4YW1wbGUuaW52YWxpZCJ9';
		assert.equal(await captureAuth(method, credential), expected);
		const signup = signupContext();
		const invalidContexts: unknown[] = [null, 'bad', { ...signup, email: 'private' }, { ...signup, expires_at: 0 }, { ...signup, variant_id: '<script>' }];
		for (const value of invalidContexts) {
			// Model untyped JS consumers at the public API boundary.
			const invalidCredential = { ...credential, signupProperties: value } as PkceCredential;
			assert.equal(await captureAuth(method, invalidCredential), expected);
		}
	});

	for (const change of ['none', 'withdraw', 'expire', 'throw'] as const) {
		test(`${method} checks ${change} at transport readiness without blocking authentication`, async () => {
			const signup = signupContext();
			let current: SignupProperties | null = signup;
			let broken = false;
			let calls = 0;
			const resolveSignup = () => {
				calls++;
				if (broken) throw new Error('unavailable');
				return current;
			};
			const wire = await captureAuth(method, { ...credential, signupProperties: resolveSignup }, () => {
				assert.equal(calls, 0, 'context is not resolved before transport readiness');
				if (change === 'withdraw') current = null;
				if (change === 'expire') current = { ...signup, exposed_at: 0, expires_at: EXPOSURE_LIFETIME_MS };
				if (change === 'throw') broken = true;
			});
			assert.equal(calls, 1);
			assert.deepEqual(JSON.parse(atob(wire.slice(3))), change === 'none' ? { ...credential, signup_properties: signup } : credential);
		});
	}
}

test('normalization enforces every schema field and the exact live exposure window', () => {
	const signup = signupContext();
	const now = signup.exposed_at;
	assert.deepEqual(normalizeSignupProperties(signup, now), signup);
	assert.notEqual(normalizeSignupProperties(signup, now), signup, 'return a copy');
	assert.deepEqual(normalizeSignupProperties(signup, signup.expires_at - 1), signup);
	assert.equal(normalizeSignupProperties(signup, signup.expires_at), null);
	for (const key of Object.keys(signup)) {
		const missing: Record<string, unknown> = { ...signup };
		delete missing[key];
		assert.equal(normalizeSignupProperties(missing, now), null, `missing ${key}`);
	}
	const invalidValues: unknown[] = [null, undefined, '', [], { ...signup, extra: true }, { ...signup, schema_version: 2 }, { ...signup, consent_version: 2 }, { ...signup, experiment: 'Capitalized' }, { ...signup, experiment_revision: '' }, { ...signup, variant_id: 'x'.repeat(81) }, { ...signup, assignment_id: 'not-a-uuid' }, { ...signup, exposure_id: '22222222-2222-3222-8222-222222222222' }, { ...signup, landing_message_revision: 'xyz' }, { ...signup, landing_message_revision: 1 }, { ...signup, exposed_at: String(now) }, { ...signup, exposed_at: NaN }, { ...signup, exposed_at: Infinity }, { ...signup, exposed_at: now + 1, expires_at: signup.expires_at + 1 }, { ...signup, expires_at: signup.expires_at + 1 }, { ...signup, expires_at: String(signup.expires_at) }];
	for (const value of invalidValues) assert.equal(normalizeSignupProperties(value, now), null);
});

for (const kind of ['getter', 'ownKeys', 'revoked'] as const) {
	test(`normalization fails closed for a hostile ${kind}`, () => {
		const signup = signupContext();
		let hostile: unknown;
		if (kind === 'getter') {
			hostile = {
				...signup,
				get experiment(): string {
					throw new Error('field unavailable');
				},
			};
		} else if (kind === 'ownKeys') {
			hostile = new Proxy(signup, {
				ownKeys: () => {
					throw new Error('keys unavailable');
				},
			});
		} else {
			const revoked = Proxy.revocable(signup, {});
			revoked.revoke();
			hostile = revoked.proxy;
		}
		assert.equal(normalizeSignupProperties(hostile), null);
	});
}

test('the public app event accepts camelCase signup context through the typed emit API', () => {
	const signup = signupContext();
	const payload: ShellEventMap['shell:loginRequest'] = { appId: 'rocketride.home', register: true, signupProperties: signup };
	const emitPayload: Parameters<typeof connectionManager.emit<'shell:loginRequest'>>[1] = payload;
	const hasSnakeCaseKey: 'signup_properties' extends keyof ShellEventMap['shell:loginRequest'] ? true : false = false;
	assert.deepEqual(emitPayload.signupProperties, signup);
	assert.equal(hasSnakeCaseKey, false);
});
