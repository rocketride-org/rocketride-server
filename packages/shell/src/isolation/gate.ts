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
// GATE — the inbound checks for one realm, in the only order there is
// =============================================================================
//
//   (1) kind and walk budget → (2) size → (3) rate → (4) op allowlist (the
//   realm's handler bus) → (5) `client.request` params `{message, timeout?}`
//   and DAP top-level keys → (6) row → (7) capability → (8) argument types
//   → (9) ownership → (10) rewrite.
//
// Quotas are checked with the rewrite (they need the row). Any exception
// that is not a denial is reported as `schema`: nothing is forwarded unless
// every step passed. The gate only reads the ledger; the root records what
// the engine answered.
// =============================================================================

import type { DAPMessage } from 'rocketride';
import { decodeMessageData } from '../connection/binaryWire';
import { CapabilityDeniedError } from './capabilityDenied';
import type { DenyCode } from './capabilityDenied';
import { matchRow, parseType } from './capabilities';
import type { CapabilityRow } from './capabilities';
import { deny } from './denial';
import type { IFsEntry, ILedger, IRunEntry, QuotaKind } from './ledger';
import { uuid4 } from './ledger';
import { canonicalAppPath } from './paths';
import { INTERVALS, QUOTAS, SIZES } from './rate';
import type { IRateLimiter } from './rate';
import type { RealmInfo } from './types';
import { b64DecodedLength, isWireBinary, measure, utf8Length, walk } from './walk';

/** DAP timeout bounds (ms): the server's own timeout error must survive the proxy's slack. */
export const DAP_TIMEOUT_MIN_MS = 1_000;
export const DAP_TIMEOUT_MAX_MS = 115_000;

const HANDLE_RE = /^rh_[A-Za-z0-9_-]{22}$/;
const RAW_CREDENTIAL_RE = /^(?:tk|pk)_/;
/** Event type names (`string[]` elements): no wildcard. */
const EVENT_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Arguments held to the short string bound. */
const NAME_ARGS: ReadonlySet<string> = new Set(['name', 'source', 'mode', 'subcommand', 'mimeType', 'provider', 'key']);
/** DAP top-level keys every request may carry. */
const DAP_KEYS: ReadonlySet<string> = new Set(['type', 'seq', 'command', 'arguments']);

/** What the gate reads. */
export interface IGateContext {
	info: RealmInfo;
	ledger: ILedger;
	rate: IRateLimiter;
	/** The session token (`''` when signed out). */
	sessionToken(): string;
	random(n: number): Uint8Array;
	/** Test hook: the gate throws (it must then fail closed). */
	throwIn?: string;
}

/** A `client.request` that passed the gate. */
export interface IGatedRequest {
	/** The message to send to the engine (real credentials, binary decoded). */
	message: DAPMessage;
	/** The clamped DAP timeout, or undefined for the SDK default. */
	timeout: number | undefined;
	command: string;
	subcommand?: string;
	/** The run the request names (token rows, restart, rrext_get_token). */
	run?: IRunEntry;
	/** `execute`: the minted project id. */
	mintedProject?: string;
	/** `fs_open`: the mode; `fs_*` handle rows: the handle. */
	fs?: IFsEntry | { handle?: undefined; mode: 'r' | 'w' };
	/** The arguments as forwarded. */
	args: Record<string, unknown>;
	/** Releases the quota slots reserved for this request (call once the answer is recorded or lost). */
	release: () => void;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An own property, never one found on the prototype chain (`toString`, `valueOf`, ...). */
const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** The ledger key of a direct (`rrext_monitor`) subscription. */
export function directMonitorKey(handle: string, pipeId: number | undefined): string {
	return `${handle}:${pipeId ?? ''}`;
}

/** Converts anything thrown inside the gate into a denial (`schema` unless it already is one). */
export function asDenial(err: unknown, op: string): CapabilityDeniedError {
	return err instanceof CapabilityDeniedError ? err : deny('schema', op);
}

/** Walks the params with the session-token check on every string. */
function walkParams(g: IGateContext, op: string, raw: unknown): Record<string, unknown> {
	if (g.throwIn === 'gate') throw new Error('test hook: gate');
	const session = g.sessionToken();
	const copy = walk(raw === undefined ? {} : raw, {
		onString(s) {
			if (s.length > SIZES.stringCeiling) throw deny('too_large', op);
			if (session !== '' && s.includes(session)) throw deny('credential', op);
		},
	});
	if (!isPlainObject(copy)) throw deny('schema', op);
	return copy;
}

/** One argument's type check (step 8). Ownership is step 9. */
function checkType(op: string, name: string, base: string, value: unknown, g: IGateContext, fail: (code: DenyCode) => never): unknown {
	const str = (max: number): string => {
		if (typeof value !== 'string' || utf8Length(value) > max) return fail('schema');
		return value;
	};
	switch (base) {
		case 'string':
			return str(NAME_ARGS.has(name) ? SIZES.name : SIZES.string);
		case 'int':
			if (!Number.isSafeInteger(value) || (value as number) < 0) fail('schema');
			return value;
		case 'int<=3600':
			if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 3600) fail('schema');
			return value;
		case 'bool':
			if (typeof value !== 'boolean') fail('schema');
			return value;
		case 'string[]':
			if (!Array.isArray(value) || value.length > 32 || !value.every((t) => typeof t === 'string' && EVENT_TYPE_RE.test(t))) fail('schema');
			return value;
		case 'json': {
			const size = measure(value);
			if (size.json + size.bin > SIZES.json) fail('too_large');
			return value;
		}
		case 'object':
		case 'object:mint-project':
		case 'object:handle-project':
			if (!isPlainObject(value)) fail('schema');
			return value;
		case 'empty-array':
			if (!Array.isArray(value) || value.length !== 0) fail('schema');
			return value;
		case 'empty-object':
			if (!isPlainObject(value) || Object.keys(value).length !== 0) fail('schema');
			return value;
		case 'bytes<=8MiB': {
			if (!isWireBinary(value)) return fail('schema');
			const n = b64DecodedLength(value.b64);
			if (n < 0) fail('schema');
			if (n > SIZES.bytes) fail('too_large');
			return value;
		}
		case 'run-handle':
		case 'minted-project': {
			const s = str(SIZES.name);
			if (RAW_CREDENTIAL_RE.test(s)) fail('credential');
			if (base === 'run-handle' && !HANDLE_RE.test(s)) fail('schema');
			return s;
		}
		case 'monitor-key:run-handle': {
			if (!isPlainObject(value) || Object.keys(value).length !== 1 || !own(value, 'token')) return fail('schema');
			checkType(op, 'token', 'run-handle', value.token, g, fail);
			return value;
		}
		case 'owned-pipe':
			if (!Number.isSafeInteger(value) || (value as number) < 0) fail('schema');
			return value;
		case 'owned-fs-handle':
			return str(SIZES.name);
		case 'app-path': {
			const s = str(SIZES.string);
			const canonical = canonicalAppPath(s, g.info.appKey);
			if (canonical === null) fail('schema');
			return canonical;
		}
		case 'app-partition':
			// `app:` + the app id, which may be 128 characters (`is_canonical_app_id`).
			if (str(SIZES.name + 'app:'.length) !== `app:${g.info.appId}`) fail('namespace');
			return value;
		case 'https-url':
			return str(SIZES.string);
		case "'r'|'w'":
			if (value !== 'r' && value !== 'w') fail('schema');
			return value;
		default:
			// The table loader refuses unknown types; reaching here is a bug — fail closed.
			return fail('schema');
	}
}

/**
 * Steps 7–8 for one row: capability, exact argument keys, types.
 *
 * @returns The arguments with canonical values (paths in NFC).
 */
function checkArgs(g: IGateContext, row: CapabilityRow, args: Record<string, unknown>, where: { op: string; command?: string; subcommand?: string }): Record<string, unknown> {
	if (!g.info.caps.has(row.cap)) throw deny('capability', where.op, { ...where, capability: row.cap });
	const fail = (code: DenyCode): never => {
		throw deny(code, where.op, where);
	};
	for (const key of Object.keys(args)) if (!own(row.args, key)) fail('schema');
	const out: Record<string, unknown> = Object.create(null);
	for (const [name, typeName] of Object.entries(row.args)) {
		const { base, optional } = parseType(typeName);
		if (!own(args, name)) {
			if (!optional) fail('schema');
			continue;
		}
		out[name] = checkType(where.op, name, base, args[name], g, fail);
	}
	return out;
}

/**
 * Admission on the router's own lanes (see `RealmContext.admit`): the rate
 * bucket, then the walk and the request size cap. `undefined` only charges.
 *
 * @param g - The realm's gate context.
 * @param lane - The op or lane name (for the denial).
 * @param value - The value as it arrived.
 * @returns The checked copy.
 */
export function admitValue(g: IGateContext, lane: string, value: unknown): unknown {
	try {
		if (!g.rate.allow('request')) throw deny('rate', lane);
		if (value === undefined) return undefined;
		const session = g.sessionToken();
		const copy = walk(value, {
			onString(s) {
				if (s.length > SIZES.stringCeiling) throw deny('too_large', lane);
				if (session !== '' && s.includes(session)) throw deny('credential', lane);
			},
		});
		const size = measure(copy);
		if (size.json + size.bin > SIZES.request) throw deny('too_large', lane);
		return copy;
	} catch (err) {
		throw asDenial(err, lane);
	}
}

/**
 * The gate for a request op other than `client.request` (and for emitOps).
 *
 * @param g - The realm's gate context.
 * @param op - The op.
 * @param raw - The params as they arrived.
 * @returns The checked params, with `run` resolved for monitor keys.
 */
export function gateOp(g: IGateContext, op: string, raw: unknown): { params: Record<string, unknown>; run?: IRunEntry } {
	const params = walkParams(g, op, raw);
	const size = measure(params);
	if (size.json + size.bin > SIZES.request) throw deny('too_large', op);
	if (!g.rate.allow('request')) throw deny('rate', op);
	if (INTERVALS[op] !== undefined && !g.rate.allow(op)) throw deny('rate', op);
	const row = matchRow(op, undefined, undefined);
	if (!row) throw deny('unknown_op', op);
	const checked = checkArgs(g, row, params, { op });
	if (row.args.key === 'monitor-key:run-handle') {
		const run = g.ledger.run((checked.key as { token: string }).token);
		if (!run) throw deny('ownership', op);
		return { params: checked, run };
	}
	return { params: checked };
}

/**
 * The gate for `client.request`.
 *
 * @param g - The realm's gate context.
 * @param raw - `{message, timeout?}` as it arrived.
 * @returns What to send to the engine, and what the root needs to record the answer.
 */
export function gateClientRequest(g: IGateContext, raw: unknown): IGatedRequest {
	const op = 'client.request';
	// (1) kind and walk budget
	const params = walkParams(g, op, raw);
	// (5, early) params are exactly {message, timeout?}
	for (const key of Object.keys(params)) if (key !== 'message' && key !== 'timeout') throw deny('schema', op);
	const message = params.message;
	if (!isPlainObject(message)) throw deny('schema', op);
	// (2) size: binary counts as binary only at `arguments.data` (the bytes slot); elsewhere it is JSON
	const size = measure(message, isPlainObject(message.arguments) ? message.arguments.data : undefined);
	if (size.json > SIZES.request || size.bin > SIZES.bytes) throw deny('too_large', op);
	// (3) rate
	if (!g.rate.allow('request')) throw deny('rate', op);
	// (5) the DAP envelope
	const command = message.command;
	if (message.type !== 'request' || typeof command !== 'string' || command === '' || utf8Length(command) > SIZES.name) throw deny('schema', op);
	if (message.seq !== undefined && !Number.isSafeInteger(message.seq)) throw deny('schema', op, { command });
	for (const key of Object.keys(message)) if (!DAP_KEYS.has(key) && key !== 'token') throw deny('schema', op, { command });
	if (message.arguments !== undefined && !isPlainObject(message.arguments)) throw deny('schema', op, { command });
	const args: Record<string, unknown> = { ...((message.arguments as Record<string, unknown> | undefined) ?? {}) };
	const subcommand = typeof args.subcommand === 'string' ? args.subcommand : undefined;
	const where = { op, command, ...(subcommand !== undefined ? { subcommand } : {}) };
	let timeout: number | undefined;
	if (params.timeout !== undefined) {
		if (typeof params.timeout !== 'number' || !Number.isFinite(params.timeout)) throw deny('schema', op, where);
		timeout = Math.min(DAP_TIMEOUT_MAX_MS, Math.max(DAP_TIMEOUT_MIN_MS, Math.round(params.timeout)));
	}
	// A run must never start unseen: execute and restart wait the root's full
	// budget, whatever the app asked (its own bus call may give up earlier).
	if (command === 'execute' || command === 'restart') timeout = DAP_TIMEOUT_MAX_MS;
	// (6) row — an unknown command or subcommand has no row: refused as a capability
	const row = matchRow(op, command, subcommand);
	if (!row) throw deny('capability', op, where);
	// (5, rest) a top-level token only where the row allows it, and never twice
	if (own(message, 'token')) {
		if (!row.top?.includes('token') || own(args, 'token')) throw deny('schema', op, where);
		args.token = message.token;
	}
	// (7, 8) capability and argument types
	const checked = checkArgs(g, row, args, where);

	// (9) ownership
	const fail = (code: DenyCode): never => {
		throw deny(code, op, where);
	};
	let run: IRunEntry | undefined;
	if (typeof checked.token === 'string') {
		run = g.ledger.run(checked.token);
		if (!run) fail('ownership');
	}
	if (row.args.projectId === 'minted-project') {
		const owner = g.ledger.runByAlias(checked.projectId as string);
		if (!owner) fail('ownership');
		if (run && owner !== run) fail('ownership');
		run = owner;
	}
	if (command === 'restart' && checked.source !== run!.source) fail('ownership');
	if (command === 'rrext_get_token' && checked.source !== run!.source) fail('ownership');
	for (const name of ['pipe_id', 'pipeId']) {
		if (own(checked, name) && !run!.pipeIds.has(checked[name] as number)) fail('ownership');
	}
	let fs: IGatedRequest['fs'];
	if (typeof checked.handle === 'string') {
		fs = g.ledger.fs(checked.handle);
		if (!fs) fail('ownership');
	}

	// (10) rewrite — real values only on the engine side; quotas before anything is started
	// Quotas count slots reserved by requests still waiting on the engine, so
	// concurrent requests cannot all pass before the first answer is recorded.
	const releases: Array<() => void> = [];
	const reserve = (kind: QuotaKind, limit: number): void => {
		if (g.ledger.used(kind) >= limit) fail('quota');
		releases.push(g.ledger.reserve(kind));
	};
	let mintedProject: string | undefined;
	if (run) checked.token = run.token;
	if (command === 'execute') {
		reserve('runs', QUOTAS.runs);
		mintedProject = `rrapp.${g.info.appKey}.${uuid4(g.random)}`;
		checked.pipeline = { ...(checked.pipeline as Record<string, unknown>), project_id: mintedProject };
	}
	if (command === 'restart') {
		checked.pipeline = { ...(checked.pipeline as Record<string, unknown>), project_id: run!.projectId };
		checked.projectId = run!.projectId;
	}
	if (command === 'rrext_get_token') {
		checked.projectId = run!.projectId;
	}
	if (command === 'rrext_process' && subcommand === 'open') reserve('pipes', QUOTAS.pipes);
	if (command === 'rrext_monitor') {
		// A direct subscription replaces the previous types for (run, pipe): only growth needs room.
		const types = new Set(checked.types as string[]).size;
		const previous = g.ledger.directMonitors.get(directMonitorKey(run!.handle, checked.pipeId as number | undefined))?.types.length ?? 0;
		const growth = types - previous;
		if (growth > 0) {
			if (g.ledger.used('monitorKeys') + growth > QUOTAS.monitorKeys) fail('quota');
			releases.push(g.ledger.reserve('monitorKeys', growth));
		}
	}
	if (command === 'rrext_store' && subcommand === 'fs_open') {
		reserve('fsHandles', QUOTAS.fsHandles);
		fs = { mode: checked.mode as 'r' | 'w' };
	}
	const forwarded = decodeMessageData({ type: 'request', seq: typeof message.seq === 'number' ? message.seq : 0, command, arguments: { ...checked } } as DAPMessage);
	return { message: forwarded, timeout, command, ...(subcommand !== undefined ? { subcommand } : {}), ...(run ? { run } : {}), ...(mintedProject ? { mintedProject } : {}), ...(fs ? { fs } : {}), args: checked, release: () => releases.forEach((r) => r()) };
}
