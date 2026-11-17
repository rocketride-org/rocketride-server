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

// =============================================================================
// N1 HARNESS — what an app realm saw, and whether any of it was real (PR2a-2)
// =============================================================================
//
// `assertNoReal` reads a realm's whole transcript. `call` normalises the three
// ways a `client.request` can end (delivered, denied, engine error), `generateToken`
// ports the engine's `generate_token` for the B3 exploit, and `openUngated`
// is the harness control's router (no app root).
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DAPMessage } from 'rocketride';
import { attachRealmToRoot } from '../../ops/busBridge';
import { createBusRouter } from '../../ops/busBridge';
import type { IBusRouter } from '../../ops/busBridge';
import { createOpBus } from '../../ops/busOps';
import type { IOpBus } from '../../ops/busOps';
import { registerClientOps } from '../../ops/clientOps';
import { isWireError } from '../../connection/errorWire';
import type { IWireEnvelope } from '../../connection/errorWire';
import type { IFakeCm } from './fakeCm';
import type { IFakeRun } from './fakeEngine';
import { clientRequest, createChannel, dap } from './realm';
import type { IChannel, IOpenedRealm } from './realm';
import { brief } from './util';

// ── generate_token (account/base.py:202-218) ──────────────────────────────────

/** Python's `json.dumps(value, sort_keys=True)`: `', '` and `': '` separators, non-ASCII as `\uXXXX`. */
function pyJson(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
	if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${pyJson(k)}: ${pyJson(v)}`).join(', ')}}`;
}

/** `f'{prefix}{sha256(json.dumps(content, sort_keys=True)).hexdigest()[:32]}'`. */
export function generateToken(content: Record<string, unknown>, prefix = ''): string {
	return `${prefix}${createHash('sha256').update(pyJson(content), 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * Vectors computed once with the engine's own `generate_token` (the function
 * body taken verbatim from `packages/ai/src/ai/account/base.py`, run under
 * CPython). The third has a non-ASCII id and the fourth the deploy shape.
 */
export const GENERATE_TOKEN_VECTORS: Array<{ content: Record<string, unknown>; prefix: string; token: string }> = [
	{ content: { kind: 'public', userId: 'local', project_id: 'p', source: 's' }, prefix: 'pk_', token: 'pk_73461d8e6d79db12faf291695e29788b' },
	{ content: { kind: 'public', teamId: 'local', project_id: 'proj é 1', source: 'chat_1' }, prefix: 'pk_', token: 'pk_b21478fbb3ccb74dfacfc3c2c08a00aa' },
	{ content: { kind: 'public', userId: 'u-1234567890abcdef', run_kind: 'deploy', project_id: 'rrapp.x.0f', source: 's' }, prefix: 'pk_', token: 'pk_2809976d1fe3ad5578673ee2f2ad78af' },
];

// ── The transcript ────────────────────────────────────────────────────────────

/** Anything with the messages a realm's port received. */
export interface IReceiver {
	received: unknown[];
}

/** Object keys a realm must never see (identity and ownership fields, plan section 2). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['teamId', 'team_id', 'devTeam', 'runKind', 'run_kind', 'ownerKind', 'owner_kind', 'orgId', 'org_id']);

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The text of a binary member when it is valid UTF-8. */
function binaryText(bytes: Uint8Array): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
}

/** Calls `cb` for every string (values and object keys) of a value; binary members are decoded to text first. */
export function eachString(value: unknown, cb: (s: string, isKey: boolean) => void): void {
	const seen = new Set<object>();
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const v = stack.pop();
		if (typeof v === 'string') cb(v, false);
		else if (v instanceof Uint8Array) {
			const text = binaryText(v);
			if (text !== undefined) cb(text, false);
		} else if (v instanceof ArrayBuffer) {
			const text = binaryText(new Uint8Array(v));
			if (text !== undefined) cb(text, false);
		} else if (typeof v === 'object' && v !== null && !seen.has(v)) {
			seen.add(v);
			const o = v as Record<string, unknown>;
			if (!Array.isArray(v) && o.__rrbin === true && typeof o.b64 === 'string') {
				const text = binaryText(Buffer.from(o.b64, 'base64'));
				if (text !== undefined) cb(text, false);
				continue;
			}
			if (Array.isArray(v)) stack.push(...v);
			else
				for (const [k, x] of Object.entries(o)) {
					cb(k, true);
					stack.push(x);
				}
		}
	}
}

/** Every object key of a value, at any depth. */
function eachKey(value: unknown, cb: (key: string) => void): void {
	const seen = new Set<object>();
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const v = stack.pop();
		if (typeof v !== 'object' || v === null || seen.has(v) || v instanceof Uint8Array || v instanceof ArrayBuffer) continue;
		seen.add(v);
		if (Array.isArray(v)) stack.push(...v);
		else
			for (const [k, x] of Object.entries(v)) {
				cb(k);
				stack.push(x);
			}
	}
}

/** Every string and every object key in `realm.received` from message `from` on, decoding `__rrbin` members to text where they are UTF-8. */
export function transcript(realm: IReceiver, from = 0): string[] {
	const out: string[] = [];
	for (const message of realm.received.slice(from)) eachString(message, (s) => out.push(s));
	return out;
}

/**
 * Fails, naming the value and the message index, when the realm's transcript
 * contains a real value: any run's `tk_`, `pk_`, project id or task id, the
 * session token, the shell API key, the engine's user id (12+ chars) or
 * anything in `extra`; or when a delivered object has a team, run-kind,
 * owner-kind or org key.
 *
 * @param realm - The realm (or anything with `received`).
 * @param cm - The fake manager (its engine's runs, session token and API key).
 * @param extra - More values that must not appear.
 * @param from - Only messages from this index on.
 */
export function assertNoReal(realm: IReceiver, cm: IFakeCm, extra: string[] = [], from = 0): void {
	const engine = cm.engine;
	const needles: Array<{ what: string; value: string }> = [];
	for (const run of engine.runs) {
		needles.push({ what: 'a real tk_', value: run.token }, { what: 'a real pk_', value: run.publicToken }, { what: 'a real project id', value: run.projectId }, { what: 'a real task id', value: run.id });
	}
	needles.push({ what: 'the session token', value: cm.sessionToken }, { what: 'the shell API key', value: cm.apiKey });
	if (engine.userId.length >= 12) needles.push({ what: 'the real user id', value: engine.userId });
	for (const value of extra) needles.push({ what: 'a value that must not appear', value });
	const live = needles.filter((n) => n.value !== '');
	realm.received.slice(from).forEach((message, offset) => {
		const index = from + offset;
		const strings: string[] = [];
		eachString(message, (s) => strings.push(s));
		// The first needle (in list order) that any string of the message holds is the one named.
		for (const n of live) if (strings.some((s) => s.includes(n.value))) assert.fail(`message ${index} carries ${n.what} (${JSON.stringify(n.value)}): ${brief(message)}`);
		eachKey(message, (key) => {
			if (FORBIDDEN_KEYS.has(key)) assert.fail(`message ${index} carries the forbidden key ${JSON.stringify(key)}: ${brief(message)}`);
		});
	});
}

// ── What a realm got back ─────────────────────────────────────────────────────

/** How a `client.request` ended, as the realm sees it. */
export type CallResult = { kind: 'ok'; response: Record<string, unknown>; body: Record<string, unknown> } | { kind: 'denied'; code: string } | { kind: 'error'; name: string; message: string };

/** Sends one DAP request through `client.request` and classifies the outcome (a refused response rejects with `RR_DENIED:`). */
export async function call(realm: IOpenedRealm, command: string, args?: Record<string, unknown>, top: Record<string, unknown> = {}): Promise<CallResult> {
	let envelope: IWireEnvelope;
	try {
		envelope = await clientRequest(realm, dap(command, args, top));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.startsWith('RR_DENIED:')) return { kind: 'denied', code: String((JSON.parse(message.slice('RR_DENIED:'.length)) as { code?: unknown }).code) };
		throw err;
	}
	if (envelope.ok) {
		const response = (envelope.value ?? {}) as Record<string, unknown>;
		return { kind: 'ok', response, body: (response.body ?? {}) as Record<string, unknown> };
	}
	if (isWireError(envelope.error) && envelope.error.name === 'CapabilityDeniedError') return { kind: 'denied', code: String(envelope.error.fields?.code) };
	return { kind: 'error', name: String(envelope.error?.name), message: String(envelope.error?.message) };
}

/** The outcome as a short string for assertion messages. */
export function describeCall(result: CallResult): string {
	return result.kind === 'ok' ? `delivered (${brief(result.response)})` : result.kind === 'denied' ? `denied (${result.code})` : `an error (${result.name}: ${result.message})`;
}

/** Asserts the response was delivered; returns its body. */
export function expectOk(result: CallResult, what: string): Record<string, unknown> {
	assert.equal(result.kind, 'ok', `${what}: expected the response to be delivered ok: true, got ${describeCall(result)}`);
	return (result as Extract<CallResult, { kind: 'ok' }>).body;
}

/** Asserts the request was refused with this denial code. */
export function expectDenied(result: CallResult, code: string, what: string): void {
	assert.equal(result.kind, 'denied', `${what}: expected a CapabilityDeniedError (${code}), got ${describeCall(result)}`);
	assert.equal((result as Extract<CallResult, { kind: 'denied' }>).code, code, `${what}: denial code`);
}

/**
 * The text of an engine error as the realm got it: a delivered `success: false`
 * response's `message`, or a thrown error's `message`. A denial is not an
 * engine error and fails here.
 */
export function engineErrorText(result: CallResult, what: string): string {
	if (result.kind === 'error') return result.message;
	assert.equal(result.kind, 'ok', `${what}: expected the engine's error to reach the realm (scrubbed), got ${describeCall(result)}`);
	const response = (result as Extract<CallResult, { kind: 'ok' }>).response;
	assert.equal(response.success, false, `${what}: expected a success: false answer, got ${brief(response)}`);
	return String(response.message);
}

// ── Events ────────────────────────────────────────────────────────────────────

/** The `client.event` payloads (`params.message`) a realm received, in order. */
export function clientEvents(realm: IReceiver): Array<Record<string, unknown>> {
	return realm.received.filter((m) => (m as { __rrbus?: string; op?: string })?.__rrbus === 'emitOp' && (m as { op?: string }).op === 'client.event').map((m) => ((m as { params?: { message?: unknown } }).params?.message ?? {}) as Record<string, unknown>);
}

// ── Runs ──────────────────────────────────────────────────────────────────────

/** The newest run the fake engine started (the real values behind the handle `startRun` returned). */
export function lastRun(cm: IFakeCm): IFakeRun {
	const run = cm.engine.runs[cm.engine.runs.length - 1];
	assert.ok(run, 'the fake engine has started no run');
	return run;
}

/** A seeded PRNG (mulberry32): the same sequence for the same seed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── B3: reproducing a pk_ from what the realm saw ─────────────────────────────

/** One (owner, project, source) triple whose `generate_token` equals a target `pk_`. */
export interface IPkReproduction {
	shape: string;
	owner: string;
	project: string;
	source: string;
	pk: string;
}

/**
 * Tries every `(ownerKey, ownerValue, project_id, source)` candidate built
 * from the realm's transcript (plus `'local'`) against `targets`:
 * owner values are `'local'` and every string seen as `userId`, `user_id`,
 * `client_id`, `teamId` or an `ru_`/`ro_`/`rp_`/`rh_` alias; project ids are
 * every token of every string; sources are `'chat_1'` and every `source`
 * value. Owner shapes are `{userId}`, `{teamId}` and `{userId, run_kind: 'deploy'}`.
 *
 * @param realm - The realm.
 * @param targets - The `pk_` values (the run's real public tokens).
 * @param from - Only messages from this index on.
 * @returns The reproductions found (none is the goal).
 */
export function reproducePk(realm: IReceiver, targets: string[], from = 0): IPkReproduction[] {
	const owners = new Set<string>(['local']);
	const projects = new Set<string>();
	const sources = new Set<string>(['chat_1']);
	const ownerKeys = new Set(['userId', 'user_id', 'client_id', 'teamId', 'team_id']);
	for (const message of realm.received.slice(from)) {
		const seen = new Set<object>();
		const stack: unknown[] = [message];
		while (stack.length > 0) {
			const v = stack.pop();
			if (typeof v === 'string') {
				projects.add(v);
				for (const token of v.match(/[A-Za-z0-9._:-]{3,}/g) ?? []) {
					projects.add(token);
					if (/^r[uohp]_/.test(token)) owners.add(token);
				}
			} else if (typeof v === 'object' && v !== null && !seen.has(v) && !(v instanceof Uint8Array)) {
				seen.add(v);
				if (Array.isArray(v)) stack.push(...v);
				else
					for (const [k, x] of Object.entries(v)) {
						if (typeof x === 'string') {
							if (ownerKeys.has(k)) owners.add(x);
							if (k === 'source') sources.add(x);
						}
						stack.push(x);
					}
			}
		}
	}
	const wanted = new Set(targets);
	const found: IPkReproduction[] = [];
	const shapes: Array<[string, (owner: string) => Record<string, unknown>]> = [
		['userId', (o) => ({ userId: o })],
		['teamId', (o) => ({ teamId: o })],
		['userId+deploy', (o) => ({ userId: o, run_kind: 'deploy' })],
	];
	for (const [shape, build] of shapes)
		for (const owner of owners)
			for (const project of projects)
				for (const source of sources) {
					const pk = generateToken({ kind: 'public', ...build(owner), project_id: project, source }, 'pk_');
					if (wanted.has(pk)) found.push({ shape, owner, project, source, pk });
				}
	return found;
}

// ── The ungated harness (T1) ──────────────────────────────────────────────────

/** A realm attached to an ordinary router over the fake manager: no app root, no gate, no scrubber. */
export interface IUngatedRealm extends IReceiver {
	bus: IOpBus;
	router: IBusRouter;
	channel: IChannel;
	/** `client.request` with a raw DAP message, as an unprotected realm sends it. */
	request(message: DAPMessage): Promise<IWireEnvelope>;
	close(): void;
}

/** Attaches one realm to `createBusRouter` plus `registerClientOps(bus, cm)`: today's behaviour for a non-isolated realm. */
export function openUngated(cm: IFakeCm): IUngatedRealm {
	const rootBus = createOpBus();
	registerClientOps(rootBus, cm);
	const router = createBusRouter(rootBus);
	const channel = createChannel();
	router.addRealm(channel.a, 'ungated');
	const bus = createOpBus();
	attachRealmToRoot(bus, channel.b);
	return {
		bus,
		router,
		channel,
		received: channel.received,
		request: (message) => bus.request('client.request', { message }) as Promise<IWireEnvelope>,
		close() {
			router.dispose();
			channel.close();
		},
	};
}
