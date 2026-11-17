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
// DENIAL — the only shapes a refusal takes on the way to an app
// =============================================================================
//
// A denied `client.request` RESOLVES to a hand-built `IWireEnvelope` error (no
// `stack`, allowlisted `fields`), which the guest rehydrates as a
// `CapabilityDeniedError`. A denied request op rejects with `RR_DENIED:` +
// JSON fields. Every other error envelope bound for a gated realm (engine
// errors, normally built by `serializeError` with their stack and every own
// field) is cut down to the same allowlist.
// =============================================================================

import { CapabilityDeniedError } from './capabilityDenied';
import type { DenyCode, ICapabilityDeniedFields } from './capabilityDenied';
import type { IWireEnvelope, IWireError } from '../connection/errorWire';

/** Prefix of a denied request op's rejection message. */
export const DENIED_PREFIX = 'RR_DENIED:';

/** The only error fields that reach an app. */
export const DENIAL_FIELDS: readonly string[] = ['code', 'op', 'command', 'subcommand', 'capability'];

/**
 * A refusal.
 *
 * @param code - Why.
 * @param op - The bus op.
 * @param extra - Command, subcommand or capability, when they apply.
 * @returns The error (thrown by the gate, formatted by the callers below).
 */
export function deny(code: DenyCode, op: string, extra: { command?: string; subcommand?: string; capability?: string } = {}): CapabilityDeniedError {
	const what = [op, extra.command, extra.subcommand].filter((s) => typeof s === 'string' && s !== '').join(' ');
	return new CapabilityDeniedError(`${what}: denied (${code})`, { code, op, ...extra });
}

/** The allowlisted fields of a denial. */
export function fieldsOf(err: CapabilityDeniedError): ICapabilityDeniedFields {
	const fields: ICapabilityDeniedFields = { code: err.code, op: err.op };
	if (err.command !== undefined) fields.command = err.command;
	if (err.subcommand !== undefined) fields.subcommand = err.subcommand;
	if (err.capability !== undefined) fields.capability = err.capability;
	return fields;
}

/**
 * The wire form of a denied `client.request`, built by hand.
 *
 * @param err - The denial.
 * @returns `{ok: false, error: {__rrerr, name, message, fields}}`.
 */
export function deniedEnvelope(err: CapabilityDeniedError): IWireEnvelope {
	return { ok: false, error: { __rrerr: true, name: 'CapabilityDeniedError', message: err.message, fields: { ...fieldsOf(err) } } };
}

/** The rejection message of a denied request op. */
export function deniedMessage(err: CapabilityDeniedError): string {
	return DENIED_PREFIX + JSON.stringify(fieldsOf(err));
}

/**
 * An outgoing envelope for a gated realm: errors lose `stack` and keep only
 * allowlisted primitive fields; values pass unchanged.
 *
 * @param envelope - What `captureEnvelope` produced.
 * @returns The envelope to send.
 */
export function sanitizeEnvelope(envelope: IWireEnvelope): IWireEnvelope {
	if (envelope.ok) return envelope;
	const source = (envelope.error?.fields ?? {}) as Record<string, unknown>;
	const fields: Record<string, unknown> = {};
	for (const key of DENIAL_FIELDS) {
		const v = source[key];
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') fields[key] = v;
	}
	const error: IWireError = { __rrerr: true, name: String(envelope.error?.name ?? 'Error'), message: String(envelope.error?.message ?? ''), fields };
	return { ok: false, error };
}
