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
// TEST UTILITIES — assertions and seeding shared by the isolation tests
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type { DenyCode } from '../capabilityDenied';
import { isWireError } from '../../connection/errorWire';
import type { IWireEnvelope } from '../../connection/errorWire';
import type { IFakeEngine } from './fakeEngine';
import { bodyOf, clientRequest, dap } from './realm';
import type { IOpenedRealm } from './realm';

/** `packages/shell`. */
export const SHELL_ROOT = path.join(__dirname, '..', '..', '..');

/** The shared capability table, read as data (never through the stubs). */
export function readCapabilityJson(): { v: number; rows: Array<{ cap: string; op: string; command?: string; subcommand?: string; args: Record<string, string>; top?: string[] }> } {
	return JSON.parse(readFileSync(path.join(SHELL_ROOT, 'isolation', 'capabilities.json'), 'utf8'));
}

/** A short rendering of any value for assertion messages. */
export function brief(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text === undefined ? 'undefined' : text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

/** The denial fields of an error envelope, or null when the value is not one. */
export function denialOf(envelope: unknown): { name: string; code: unknown; fields: Record<string, unknown>; message: string } | null {
	const env = envelope as IWireEnvelope | undefined;
	if (!env || env.ok !== false || !isWireError(env.error)) return null;
	return { name: env.error.name, code: env.error.fields?.code, fields: env.error.fields ?? {}, message: env.error.message };
}

/**
 * Asserts a `client.request` envelope is a denial with one of `codes`
 * (`ok: false`, `error.name === 'CapabilityDeniedError'`, `fields.code`).
 */
export function assertDenied(envelope: unknown, codes: DenyCode | DenyCode[], what: string): void {
	const want = Array.isArray(codes) ? codes : [codes];
	const d = denialOf(envelope);
	assert.ok(d, `${what}: expected a CapabilityDeniedError envelope (ok: false), got ${brief(envelope)}`);
	assert.equal(d.name, 'CapabilityDeniedError', `${what}: error name`);
	assert.ok(want.includes(d.code as DenyCode), `${what}: expected denial code ${want.join(' or ')}, got ${brief(d.code)}`);
}

/** Asserts a non-`client.request` op rejected with `RR_DENIED:` and one of `codes`. */
export async function assertDeniedOp(promise: Promise<unknown>, codes: DenyCode | DenyCode[], what: string): Promise<void> {
	const want = Array.isArray(codes) ? codes : [codes];
	let outcome: { ok: true; value: unknown } | { ok: false; message: string };
	try {
		outcome = { ok: true, value: await promise };
	} catch (err) {
		outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
	assert.ok(!outcome.ok, `${what}: expected a denial, the op resolved with ${brief((outcome as { value?: unknown }).value)}`);
	const message = (outcome as { message: string }).message;
	assert.ok(message.startsWith('RR_DENIED:'), `${what}: expected a rejection starting with RR_DENIED:, got ${JSON.stringify(message)}`);
	const parsed = JSON.parse(message.slice('RR_DENIED:'.length)) as { code?: string };
	assert.ok(want.includes(parsed.code as DenyCode), `${what}: expected denial code ${want.join(' or ')}, got ${brief(parsed.code)}`);
}

/** Asserts the engine saw no message after index `since`. */
export function assertNotForwarded(engine: IFakeEngine, since: number, what: string): void {
	const extra = engine.received.slice(since).map((r) => r.message.command);
	assert.equal(extra.length, 0, `${what}: expected nothing forwarded to the engine, but it received ${brief(extra)}`);
}

/** A started run, as the realm sees it. */
export interface ISeedRun {
	/** What `execute` returned as `token` (a handle once the gate is in). */
	token: string;
	projectId: string;
	id: string;
	source: string;
	body: Record<string, unknown>;
}

/** Starts a run through the root as the realm would, and returns what it received. */
export async function startRun(realm: IOpenedRealm, source = 'chat_1', extra: Record<string, unknown> = {}): Promise<ISeedRun> {
	const envelope = await clientRequest(realm, dap('execute', { pipeline: { components: [], source }, args: [], ttl: 60, ...extra }));
	assert.equal(envelope.ok, true, `setup: execute must be allowed, got ${brief(envelope)}`);
	const body = bodyOf(envelope);
	return { token: String(body.token), projectId: String(body.projectId), id: String(body.id), source: String(body.source), body };
}

/** Opens a data pipe on a run; returns the `pipe_id` the realm received. */
export async function openPipe(realm: IOpenedRealm, token: string): Promise<number> {
	const envelope = await clientRequest(realm, dap('rrext_process', { subcommand: 'open', object: {}, mimeType: 'application/octet-stream', token }));
	assert.equal(envelope.ok, true, `setup: rrext_process open must be allowed, got ${brief(envelope)}`);
	return Number(bodyOf(envelope).pipe_id);
}

/** Opens a store handle; returns it. */
export async function openFs(realm: IOpenedRealm, filePath: string, mode: 'r' | 'w' = 'r'): Promise<string> {
	const envelope = await clientRequest(realm, dap('rrext_store', { subcommand: 'fs_open', path: filePath, mode }));
	assert.equal(envelope.ok, true, `setup: fs_open ${filePath} must be allowed, got ${brief(envelope)}`);
	return String(bodyOf(envelope).handle);
}

/** What an awaited op did: resolved with a value, or rejected with a message. */
export type Outcome = { ok: true; value: unknown } | { ok: false; message: string };

/** Awaits a promise without throwing, so a test can assert on the outcome. */
export async function outcome(promise: Promise<unknown>): Promise<Outcome> {
	try {
		return { ok: true, value: await promise };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}

/** Asserts an op resolved, with a readable message when it did not. */
export function assertResolved(result: Outcome, what: string): unknown {
	assert.ok(result.ok, `${what}: expected the op to resolve, it rejected with ${JSON.stringify((result as { message?: string }).message)}`);
	return (result as { value: unknown }).value;
}

/** Whether a promise has settled after the channel drained (never waits for it). */
export function trackSettled(promise: Promise<unknown>): { settled: () => boolean } {
	let done = false;
	promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		}
	);
	return { settled: () => done };
}

/** The DAP response body of a `client.request` envelope that resolved ok. */
export function bodyOfResponse(envelope: unknown): Record<string, unknown> {
	const env = envelope as { ok?: boolean; value?: { body?: Record<string, unknown> } };
	assert.equal(env.ok, true, `expected an ok envelope, got ${brief(envelope)}`);
	return env.value?.body ?? {};
}

/**
 * Best-of-`n` wall-clock times of a measured run and its control, taken in
 * alternating rounds so both see the same host load.
 */
export async function bestPair(n: number, control: () => Promise<void>, measured: () => Promise<void>): Promise<{ control: number; measured: number }> {
	const out = { control: Infinity, measured: Infinity };
	for (let i = 0; i < n; i++) {
		for (const [key, run] of [
			['control', control],
			['measured', measured],
		] as const) {
			const start = performance.now();
			await run();
			out[key] = Math.min(out[key], performance.now() - start);
		}
	}
	return out;
}

/**
 * A cost bound that holds on a quiet host and on a loaded one.
 *
 * CI runs this suite beside others on the same runner, so an absolute budget
 * alone measures the neighbours (8 MiB outbound: 128 ms on a laptop, 1.7 s on
 * a loaded runner). The control is the same operation with the root's sets
 * empty, timed in the same rounds: the run passes under `budgetMs`, or under
 * `ratio` times its control. A cost that grows with the needle sets is
 * orders of magnitude over its control and fails either way.
 */
export function assertCost(what: string, t: { control: number; measured: number }, budgetMs: number, ratio: number): void {
	assert.ok(t.measured < budgetMs || t.measured < ratio * t.control, `${what} took ${t.measured.toFixed(1)} ms against a ${t.control.toFixed(1)} ms control (budget ${budgetMs} ms or ${ratio}x)`);
}
