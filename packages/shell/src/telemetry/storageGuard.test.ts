import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStorageGuard, persistenceProto, scrubStoredProps } from './storageGuard.ts';
import { reduceStoredProps } from './sanitize.ts';

/** A stand-in for posthog-js's PostHogPersistence: register and register_once write into props. */
function fakePersistenceClass() {
	class FakePersistence {
		props: Record<string, unknown> = {};
		writes: Array<Record<string, unknown>> = [];
		register(props: Record<string, unknown>): boolean { this.writes.push(props); Object.assign(this.props, props); return true; }
		register_once(props: Record<string, unknown>, _default?: unknown): boolean {
			this.writes.push(props);
			for (const [k, v] of Object.entries(props)) if (!(k in this.props)) this.props[k] = v;
			return true;
		}
		unregister(key: string): void { delete this.props[key]; }
	}
	return FakePersistence;
}

test('installStorageGuard: every register and register_once write is reduced before it is stored', () => {
	const Persistence = fakePersistenceClass();
	const p = new Persistence();
	assert.equal(installStorageGuard(persistenceProto(p), reduceStoredProps), true);
	p.register_once({ $initial_person_info: { u: 'https://cloud.rocketride.ai/?email=a%40b.test&utm_source=s', r: 'https://mail.test/?u=secret' } }, undefined);
	p.register({ $client_session_props: { sessionId: 's', props: { u: 'https://cloud.rocketride.ai/?code=secret', r: '$direct' } }, gclid: 'secret', $fbc_persistence: { value: 'secret' }, $referrer: 'https://g.test/?q=secret' });
	assert.equal(JSON.stringify(p.props).includes('secret'), false, JSON.stringify(p.props));
	assert.equal(JSON.stringify(p.writes).includes('secret'), false, 'the raw value never reaches the write');
	assert.deepEqual(p.props.$initial_person_info, { u: 'https://cloud.rocketride.ai/?utm_source=s', r: 'https://mail.test' });
	assert.equal(p.props.$referrer, 'https://g.test');
	// a second instance of the same class is guarded too (the prototype is shared)
	const q = new Persistence();
	q.register({ $current_url: 'https://x.test/?token=secret' });
	assert.equal(q.props.$current_url, 'https://x.test/');
});

test('installStorageGuard: idempotent, and false for anything that is not a persistence prototype', () => {
	const Persistence = fakePersistenceClass();
	const proto = Persistence.prototype;
	assert.equal(installStorageGuard(proto, reduceStoredProps), true);
	const wrapped = proto.register;
	assert.equal(installStorageGuard(proto, reduceStoredProps), true);
	assert.equal(proto.register, wrapped, 'not wrapped twice');
	assert.equal(installStorageGuard(null, reduceStoredProps), false);
	assert.equal(installStorageGuard({ register() {} }, reduceStoredProps), false);
	assert.equal(installStorageGuard(persistenceProto(undefined), reduceStoredProps), false);
});

test('installStorageGuard: non-object writes pass through unchanged', () => {
	const Persistence = fakePersistenceClass();
	installStorageGuard(Persistence.prototype, reduceStoredProps);
	const p = new Persistence();
	assert.equal(p.register(null as never), true);
	assert.deepEqual(p.writes, [null]);
});

test('scrubStoredProps: values already held (loaded from storage) are reduced, dropped ones unregistered', () => {
	const Persistence = fakePersistenceClass();
	installStorageGuard(Persistence.prototype, reduceStoredProps);
	const p = new Persistence();
	p.props = { $initial_person_info: { u: 'https://cloud.rocketride.ai/?email=secret', r: '$direct' }, gclid: 'secret', distinct_id: 'd' };
	scrubStoredProps(p, reduceStoredProps);
	assert.deepEqual(p.props, { $initial_person_info: { u: 'https://cloud.rocketride.ai/', r: '$direct' }, distinct_id: 'd' });
	scrubStoredProps(null, reduceStoredProps);
	scrubStoredProps({ props: null }, reduceStoredProps);
});
