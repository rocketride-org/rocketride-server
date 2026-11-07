// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { DeveloperIdentity, LOOKUP_FAILED_MESSAGE, STATUS_TIMEOUT_MS, makeRegisterDeveloperHandler } from '../appdev/developerIdentity';
import type { IDeveloperClient, IDeveloperConnection } from '../appdev/developerIdentity';
import type { NewAppIdentity } from 'shared/tools/appdev/types';

/** Knobs for a fake connected client. */
interface IFake {
	connected?: boolean;
	loginId?: string;
	orgId?: string;
	status?: string | null | Error | Promise<string | null>;
	registerReturns?: string;
	/** Runs while the register request is in flight (e.g. a disconnect). */
	duringRegister?: (setOrg: (orgId: string | undefined) => void) => void;
}

/**
 * The status reply, bounded the way the real client bounds a request with a
 * `timeout` option: past the limit it rejects and ignores any later reply.
 */
function statusReply(status: IFake['status'], timeoutMs: number | undefined): Promise<{ developerId: string | null }> {
	if (status instanceof Error) return Promise.reject(status);
	if (!(status instanceof Promise)) return Promise.resolve({ developerId: status ?? null });
	const reply = status.then((developerId) => ({ developerId }));
	if (timeoutMs === undefined) return reply;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
		void reply.then((value) => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}

/** A fake connection plus a log of the server calls (and status time limits) it received. */
function fake(opts: IFake): { connection: IDeveloperConnection; calls: string[]; timeouts: (number | undefined)[]; setOrg: (orgId: string | undefined) => void } {
	const calls: string[] = [];
	const timeouts: (number | undefined)[] = [];
	let orgId: string | undefined = 'orgId' in opts ? opts.orgId : 'org-1';
	const setOrg = (next: string | undefined): void => {
		orgId = next;
	};
	const client: IDeveloperClient = {
		getAccountInfo: () => ({ organization: opts.loginId ? { developerId: opts.loginId } : {} }),
		getOrgId: () => orgId,
		call: async <T>(command: string, args?: Record<string, unknown>, options?: { timeout?: number }): Promise<T> => {
			assert.equal(command, 'rrext_deploy_app');
			assert.equal(args?.subcommand, 'developer_status');
			calls.push('status');
			timeouts.push(options?.timeout);
			return (await statusReply(opts.status, options?.timeout)) as T;
		},
		registerDeveloper: async (id) => {
			calls.push(`register:${id}`);
			opts.duringRegister?.(setOrg);
			return opts.registerReturns ? { developerId: opts.registerReturns } : {};
		},
	};
	const connection: IDeveloperConnection = {
		getClient: () => (opts.connected === false ? undefined : client),
		isConnected: () => opts.connected !== false,
	};
	return { connection, calls, timeouts, setOrg };
}

// ── resolve() ────────────────────────────────────────────────────────────────

test('resolve: login-time id wins without a server lookup', async () => {
	const { connection, calls } = fake({ loginId: 'acme', status: 'other' });
	const r = await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(r, { developerId: 'acme', source: 'organization', canRegisterDeveloper: false, lookupFailed: false });
	assert.deepEqual(calls, []);
});

test('resolve: session claim, same org, is used without a server lookup', async () => {
	const { connection, calls } = fake({ status: null, registerReturns: 'acme_labs' });
	const identity = new DeveloperIdentity(connection);
	await identity.register('acme_labs');
	const r = await identity.resolve();
	assert.equal(r.developerId, 'acme_labs');
	assert.equal(r.source, 'organization');
	assert.deepEqual(calls, ['register:acme_labs']);
});

test('resolve: session claim, different org, is ignored and the server is asked', async () => {
	const { connection, calls, setOrg } = fake({ status: null });
	const identity = new DeveloperIdentity(connection);
	await identity.register('acme_labs');
	setOrg('org-2');
	const r = await identity.resolve();
	assert.equal(r.developerId, 'local');
	assert.equal(r.canRegisterDeveloper, true);
	assert.deepEqual(calls, ['register:acme_labs', 'status']);
});

test('resolve: register reads the org before the request', async () => {
	// The org blanks while the request is in flight (a disconnect), then returns.
	const { connection, calls, setOrg } = fake({ status: null, registerReturns: 'acme_labs', duringRegister: (set) => set(undefined) });
	const identity = new DeveloperIdentity(connection);
	await identity.register('acme_labs');
	setOrg('org-1');
	const r = await identity.resolve();
	assert.equal(r.developerId, 'acme_labs');
	assert.deepEqual(calls, ['register:acme_labs']);
});

test('resolve: a claim made with no org is never reused', async () => {
	const { connection, calls } = fake({ orgId: undefined, status: null, registerReturns: 'acme_labs' });
	const identity = new DeveloperIdentity(connection);
	await identity.register('acme_labs');
	const r = await identity.resolve();
	assert.equal(r.developerId, 'local');
	assert.deepEqual(calls, ['register:acme_labs', 'status']);
});

test('resolve: status returns an id', async () => {
	const { connection } = fake({ status: 'acme' });
	const r = await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(r, { developerId: 'acme', source: 'organization', canRegisterDeveloper: false, lookupFailed: false });
});

test('resolve: status returns null, so the wizard may register', async () => {
	const { connection } = fake({ status: null });
	const r = await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(r, { developerId: 'local', source: 'default', canRegisterDeveloper: true, lookupFailed: false });
});

test('resolve: status throws, so local is shown and the form is hidden', async () => {
	const { connection } = fake({ status: new Error('timeout') });
	const r = await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(r, { developerId: 'local', source: 'default', canRegisterDeveloper: false, lookupFailed: true });
});

test('resolve: disconnected falls back to local without a lookup', async () => {
	const { connection, calls } = fake({ connected: false });
	const r = await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(r, { developerId: 'local', source: 'default', canRegisterDeveloper: false, lookupFailed: false });
	assert.deepEqual(calls, []);
});

// ── resolveForScaffold() ─────────────────────────────────────────────────────

test('scaffold rejects when the status lookup fails', async () => {
	const { connection } = fake({ status: new Error('timeout') });
	await assert.rejects(new DeveloperIdentity(connection).resolveForScaffold(), { message: LOOKUP_FAILED_MESSAGE });
});

test('scaffold uses local when disconnected', async () => {
	const { connection } = fake({ connected: false });
	assert.equal(await new DeveloperIdentity(connection).resolveForScaffold(), 'local');
});

test('scaffold uses local when the org has no id', async () => {
	const { connection } = fake({ status: null });
	assert.equal(await new DeveloperIdentity(connection).resolveForScaffold(), 'local');
});

test('resolve: the status lookup passes its time limit to the client', async () => {
	const { connection, timeouts } = fake({ status: 'acme' });
	await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(timeouts, [STATUS_TIMEOUT_MS]);
	assert.ok(STATUS_TIMEOUT_MS < 120_000, 'shorter than the bus request timeout');
});

test('resolve: status hangs, so the lookup times out', async () => {
	const { connection } = fake({ status: new Promise<string | null>(() => {}) });
	const started = Date.now();
	const r = await new DeveloperIdentity(connection, 20).resolve();
	assert.deepEqual(r, { developerId: 'local', source: 'default', canRegisterDeveloper: false, lookupFailed: true });
	assert.ok(Date.now() - started < 1000);
});

test('scaffold: a late status reply does not rescue a timed-out scaffold', async () => {
	let reply!: (id: string) => void;
	const late = new Promise<string | null>((resolve) => (reply = resolve));
	const { connection } = fake({ status: late });
	const scaffold = new DeveloperIdentity(connection, 20).resolveForScaffold();
	await assert.rejects(scaffold, { message: LOOKUP_FAILED_MESSAGE });
	reply('acme'); // the server answers after the limit
	await assert.rejects(scaffold, { message: LOOKUP_FAILED_MESSAGE });
});

// ── host.appdev.registerDeveloper handler ────────────────────────────────────

/** The handler wired to a fake connection, recording broadcasts. */
function handler(opts: IFake): { run: (id: string) => Promise<NewAppIdentity>; broadcasts: [string, unknown][]; calls: string[] } {
	const { connection, calls } = fake(opts);
	const identity = new DeveloperIdentity(connection);
	const broadcasts: [string, unknown][] = [];
	const buildIdentity = async (): Promise<NewAppIdentity> => {
		const r = await identity.resolve();
		return { developerId: r.developerId, source: r.source, canRegisterDeveloper: r.canRegisterDeveloper, workspaceOpen: true, existingFolders: [] };
	};
	const run = makeRegisterDeveloperHandler({ identity, buildIdentity, broadcast: (op, p) => broadcasts.push([op, p]) });
	return { run: (developerId) => run({ developerId }), broadcasts, calls };
}

test('register: not connected rejects and broadcasts nothing', async () => {
	const h = handler({ connected: false });
	await assert.rejects(h.run('acme'), { message: 'Not connected to server' });
	assert.deepEqual(h.broadcasts, []);
});

test('register: empty id rejects without calling the server', async () => {
	const h = handler({ status: null });
	await assert.rejects(h.run('   '), { message: 'Enter a developer id' });
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.broadcasts, []);
});

test('register: success broadcasts identityChanged with the new id and returns it', async () => {
	const h = handler({ status: null, registerReturns: 'acme_labs' });
	const identity = await h.run(' acme_labs ');
	assert.equal(identity.developerId, 'acme_labs');
	assert.equal(identity.source, 'organization');
	assert.deepEqual(h.calls, ['register:acme_labs']);
	assert.deepEqual(h.broadcasts, [['host.appdev.identityChanged', identity]]);
});

test('register: a server refusal rejects with its message and broadcasts nothing', async () => {
	const { connection } = fake({ status: null });
	const identity = new DeveloperIdentity({ ...connection, getClient: () => ({ ...connection.getClient()!, registerDeveloper: async () => { throw new Error('slug taken'); } }) });
	const broadcasts: unknown[] = [];
	const run = makeRegisterDeveloperHandler({ identity, buildIdentity: async () => ({}) as NewAppIdentity, broadcast: (op) => broadcasts.push(op) });
	await assert.rejects(run({ developerId: 'acme' }), { message: 'slug taken' });
	assert.deepEqual(broadcasts, []);
});
