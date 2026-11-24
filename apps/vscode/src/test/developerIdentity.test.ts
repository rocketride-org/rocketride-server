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

import { DeveloperIdentity, IdentityFeed, REGISTER_TIMEOUT_MS, STATUS_TIMEOUT_MS, makeRegisterDeveloperHandler, toWizardIdentity } from '../appdev/developerIdentity';
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
	/** The register request rejects with this error... */
	registerFails?: Error;
	/** ...although the claim landed on the server as this id (a late timeout). */
	claimLandsAs?: string;
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
function fake(opts: IFake): { connection: IDeveloperConnection; calls: string[]; timeouts: (number | undefined)[]; registerTimeouts: (number | undefined)[]; setOrg: (orgId: string | undefined) => void } {
	const calls: string[] = [];
	const timeouts: (number | undefined)[] = [];
	const registerTimeouts: (number | undefined)[] = [];
	let status = opts.status;
	let orgId: string | undefined = 'orgId' in opts ? opts.orgId : 'org-1';
	const setOrg = (next: string | undefined): void => {
		orgId = next;
	};
	const client: IDeveloperClient = {
		getAccountInfo: () => ({ organization: opts.loginId ? { developerId: opts.loginId } : {} }),
		getOrgId: () => orgId,
		developerStatus: async (options?: { timeout?: number }) => {
			calls.push('status');
			timeouts.push(options?.timeout);
			return statusReply(status, options?.timeout);
		},

		registerDeveloper: async (id, options) => {
			calls.push(`register:${id}`);
			registerTimeouts.push(options?.timeout);
			opts.duringRegister?.(setOrg);
			if (opts.claimLandsAs) status = opts.claimLandsAs;
			if (opts.registerFails) throw opts.registerFails;
			return opts.registerReturns ? { developerId: opts.registerReturns } : {};
		},
	};
	const connection: IDeveloperConnection = {
		getClient: () => (opts.connected === false ? undefined : client),
		isConnected: () => opts.connected !== false,
	};
	return { connection, calls, timeouts, registerTimeouts, setOrg };
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
	assert.equal(r.developerId, '');
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
	assert.equal(r.developerId, '');
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
	assert.deepEqual(r, { developerId: '', source: 'default', canRegisterDeveloper: true, lookupFailed: false });
});

test('resolve: status throws, so no id is shown and the form is hidden', async () => {
	const { connection } = fake({ status: new Error('timeout') });
	const r = await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(r, { developerId: '', source: 'default', canRegisterDeveloper: false, lookupFailed: true });
});

test('resolve: disconnected shows no id, without a lookup', async () => {
	const { connection, calls } = fake({ connected: false });
	const r = await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(r, { developerId: '', source: 'default', canRegisterDeveloper: false, lookupFailed: false });
	assert.deepEqual(calls, []);
});

test('resolve: the status lookup passes its time limit to the client', async () => {
	const { connection, timeouts } = fake({ status: 'acme' });
	await new DeveloperIdentity(connection).resolve();
	assert.deepEqual(timeouts, [STATUS_TIMEOUT_MS]);
	assert.ok(STATUS_TIMEOUT_MS < 120_000, 'shorter than the bus request timeout');
});

test('resolve: status hangs, so the lookup times out', async () => {
	const { connection } = fake({ status: new Promise<string | null>(() => {}) });
	const lines: string[] = [];
	const started = Date.now();
	const r = await new DeveloperIdentity(connection, 20, (line) => {
		lines.push(line);
	}).resolve();
	assert.deepEqual(r, { developerId: '', source: 'default', canRegisterDeveloper: false, lookupFailed: true });
	assert.equal(lines.length, 1);
	assert.match(lines[0], /timed out/);
	assert.ok(Date.now() - started < 1000);
});

test('resolve: a late status reply does not change a lookup that timed out', async () => {
	let reply!: (id: string) => void;
	const late = new Promise<string | null>((resolve) => (reply = resolve));
	const { connection } = fake({ status: late });
	const resolved = new DeveloperIdentity(connection, 20).resolve();
	assert.equal((await resolved).lookupFailed, true);
	reply('acme'); // the server answers after the limit
	assert.equal((await resolved).lookupFailed, true);
});

// ── host.appdev.registerDeveloper handler ────────────────────────────────────

/** The handler wired to a fake connection through an IdentityFeed, recording broadcasts. */
function handler(opts: IFake): { run: (id: string) => Promise<NewAppIdentity>; broadcasts: [string, NewAppIdentity][]; calls: string[]; registerTimeouts: (number | undefined)[] } {
	const { connection, calls, registerTimeouts } = fake(opts);
	const identity = new DeveloperIdentity(connection);
	const broadcasts: [string, NewAppIdentity][] = [];
	const feed = new IdentityFeed(
		async () => toWizardIdentity(await identity.resolve(), { workspaceOpen: true, existingFolders: [] }),
		(op, p) => {
			broadcasts.push([op, p as NewAppIdentity]);
		}
	);
	const run = makeRegisterDeveloperHandler({ identity, feed });
	return { run: (developerId) => run({ developerId }), broadcasts, calls, registerTimeouts };
}

test('register: not connected rejects without calling the server', async () => {
	const h = handler({ connected: false });
	await assert.rejects(h.run('acme'), { message: 'Not connected to server' });
	assert.deepEqual(h.calls.filter((c) => c.startsWith('register:')), []);
	assert.equal(h.broadcasts.at(-1)?.[1].developerId, '');
});

test('register: empty id rejects without calling the server', async () => {
	const h = handler({ status: null });
	await assert.rejects(h.run('   '), { message: 'Enter a developer id' });
	assert.deepEqual(h.calls.filter((c) => c.startsWith('register:')), []);
});

test('register: success broadcasts identityChanged with the new id and returns it', async () => {
	const h = handler({ status: null, registerReturns: 'acme_labs' });
	const identity = await h.run(' acme_labs ');
	assert.equal(identity.developerId, 'acme_labs');
	assert.equal(identity.source, 'organization');
	assert.deepEqual(h.calls, ['register:acme_labs']);
	assert.deepEqual(h.broadcasts, [['host.appdev.identityChanged', identity]]);
});

test('register: a server refusal rejects with its message and refreshes the wizards', async () => {
	const h = handler({ status: null, registerFails: new Error('slug taken') });
	await assert.rejects(h.run('acme'), { message: 'slug taken' });
	assert.equal(h.broadcasts.length, 1);
	assert.equal(h.broadcasts[0][1].canRegisterDeveloper, true);
});

test('register: the request passes its time limit to the client', async () => {
	const h = handler({ status: null, registerReturns: 'acme' });
	await h.run('acme');
	assert.deepEqual(h.registerTimeouts, [REGISTER_TIMEOUT_MS]);
	assert.ok(REGISTER_TIMEOUT_MS < 120_000, 'shorter than the bus request timeout');
});

test('register: a failed claim still refreshes every wizard', async () => {
	// The request times out, but the claim landed on the server.
	const h = handler({ status: null, registerFails: new Error('Request timed out after 30000ms'), claimLandsAs: 'acme' });
	await assert.rejects(h.run('acme'), { message: /timed out/ });
	const pushed = h.broadcasts.at(-1)?.[1];
	assert.equal(pushed?.developerId, 'acme');
	assert.equal(pushed?.source, 'organization');
});

// ── P18: the newest identity always wins ───────────────────────────────────

test('identity feed: a slower older refresh never overwrites a newer one', async () => {
	const builds: ((i: NewAppIdentity) => void)[] = [];
	const broadcasts: NewAppIdentity[] = [];
	const feed = new IdentityFeed(
		() => new Promise<NewAppIdentity>((resolve) => builds.push(resolve)),
		(_op, p) => {
			broadcasts.push(p as NewAppIdentity);
		}
	);
	const older = feed.refresh(true); // slow lookup starts first
	const newer = feed.refresh(true); // e.g. a disconnect, answered at once
	builds[1]({ developerId: '', source: 'default', workspaceOpen: true, existingFolders: [] });
	const n = await newer;
	builds[0]({ developerId: '', source: 'default', workspaceOpen: true, existingFolders: [], lookupFailed: true });
	const o = await older;
	assert.deepEqual(broadcasts, [n], 'only the newest build is pushed');
	assert.ok((o.revision ?? 0) < (n.revision ?? 0), 'the older build carries the older revision');
});

test('identity feed: a pull does not suppress an in-flight push', async () => {
	const builds: ((i: NewAppIdentity) => void)[] = [];
	const broadcasts: NewAppIdentity[] = [];
	const feed = new IdentityFeed(
		() => new Promise<NewAppIdentity>((resolve) => builds.push(resolve)),
		(_op, p) => {
			broadcasts.push(p as NewAppIdentity);
		}
	);
	const push = feed.refresh(true); // a claim landed: every wizard must hear it
	const pull = feed.refresh(false); // meanwhile another wizard opens and pulls
	builds[1]({ developerId: 'acme', source: 'organization', workspaceOpen: true, existingFolders: [] });
	const pulled = await pull;
	builds[0]({ developerId: 'acme', source: 'organization', workspaceOpen: true, existingFolders: [] });
	const pushed = await push;
	assert.deepEqual(broadcasts, [pushed], 'the push still reaches every wizard');
	assert.ok((pulled.revision ?? 0) > (pushed.revision ?? 0), 'the pulling wizard keeps its newer revision');
});

// ── What the wizard shows: the organization's id or none, and why a lookup failed ─

/** Every lookup outcome, each with a fresh identity in that state, and the id and source it shows. */
async function outcomes(): Promise<[string, DeveloperIdentity, string, NewAppIdentity['source']][]> {
	const claimed = new DeveloperIdentity(fake({ status: null, registerReturns: 'acme_labs' }).connection);
	await claimed.register('acme_labs');
	return [
		['login id', new DeveloperIdentity(fake({ loginId: 'acme' }).connection), 'acme', 'organization'],
		['session claim', claimed, 'acme_labs', 'organization'],
		['status id', new DeveloperIdentity(fake({ status: 'acme' }).connection), 'acme', 'organization'],
		['no id', new DeveloperIdentity(fake({ status: null }).connection), '', 'default'],
		['disconnected', new DeveloperIdentity(fake({ connected: false }).connection), '', 'default'],
		['lookup failed', new DeveloperIdentity(fake({ status: new Error('500') }).connection), '', 'default'],
	];
}

test('shown: every lookup outcome shows the organization id or none, never a default id', async () => {
	// An app's files carry the slug; the id is attached at deploy, so there is nothing to default to.
	const workspace = { workspaceOpen: true, existingFolders: [] };
	for (const [name, identity, developerId, source] of await outcomes()) {
		const shown = toWizardIdentity(await identity.resolve(), workspace);
		assert.deepEqual([shown.developerId, shown.source], [developerId, source], name);
		assert.equal(shown.canRegisterDeveloper, name === 'no id', `${name}: only an organization known to have no id may claim one`);
		assert.equal(shown.lookupFailed, name === 'lookup failed', name);
	}
});

test('shown: the wizard identity says when the lookup failed', async () => {
	const failed = await new DeveloperIdentity(fake({ status: new Error('500') }).connection).resolve();
	const ok = await new DeveloperIdentity(fake({ status: 'acme' }).connection).resolve();
	assert.equal(toWizardIdentity(failed, { workspaceOpen: true, existingFolders: [] }).lookupFailed, true);
	assert.equal(toWizardIdentity(ok, { workspaceOpen: true, existingFolders: [] }).lookupFailed, false);
});

test('resolve: a failed lookup is logged', async () => {
	const lines: string[] = [];
	const identity = new DeveloperIdentity(fake({ status: new Error('500 internal error') }).connection, STATUS_TIMEOUT_MS, (line) => {
		lines.push(line);
	});
	await identity.resolve();
	assert.equal(lines.length, 1);
	assert.match(lines[0], /500 internal error/);
});
