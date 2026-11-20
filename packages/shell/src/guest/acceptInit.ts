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
// GUEST INIT ACCEPTANCE — the guest side of the handshake (PR2b, plan §3.4, §4.1)
// =============================================================================
//
// The shell origins come only from the frame document's
// `<meta name="rr-shell-origins">` (the server writes them). The guest posts
// one `rr:frame:ready` to each, with that origin as `targetOrigin`, and
// accepts exactly ONE `rr:bridge:init`: from `parent`, at a listed origin,
// with exactly one port and a well-formed body. Everything the guest knows
// about itself (app id, key, module, view, engine URL) comes from that init.
// =============================================================================

import type { BridgeInit } from '../isolation/types';

/** The only protocol version this guest speaks. */
export const GUEST_PROTO = 1;

const ENTRY_PREFIX_RE = /^\/_t\/(?!\.+\/)[A-Za-z0-9._-]+\/v[0-9]{1,9}\/$/;

/** A plain http(s) origin, or null. */
function plainOrigin(raw: string): string | null {
	try {
		const u = new URL(raw);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		return u.origin === raw ? raw : null;
	} catch {
		return null;
	}
}

/** The `rr-shell-origins` meta value as a list of http(s) origins (anything else dropped). */
export function parseShellOrigins(content: string | null | undefined): string[] {
	if (typeof content !== 'string') return [];
	const out: string[] = [];
	for (const part of content.split(/[\s,]+/)) {
		const o = part ? plainOrigin(part) : null;
		if (o && !out.includes(o)) out.push(o);
	}
	return out;
}

/** One ready message per shell origin, each addressed to that origin. */
export function readyMessages(origins: readonly string[]): Array<{ targetOrigin: string; message: { type: 'rr:frame:ready'; protoMin: number; protoMax: number } }> {
	return origins.map((targetOrigin) => ({ targetOrigin, message: { type: 'rr:frame:ready', protoMin: GUEST_PROTO, protoMax: GUEST_PROTO } }));
}

/** An origin plus path only: no userinfo, query or fragment. */
export function isEngineHttpUrl(raw: unknown): boolean {
	if (typeof raw !== 'string' || raw === '' || raw.includes('?') || raw.includes('#')) return false;
	try {
		const u = new URL(raw);
		return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '';
	} catch {
		return false;
	}
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Whether `data` is a well-formed `rr:bridge:init` this guest can use. */
export function isBridgeInit(data: unknown): data is BridgeInit {
	if (!isObject(data)) return false;
	const d = data;
	if (d.type !== 'rr:bridge:init' || d.proto !== GUEST_PROTO) return false;
	if (typeof d.entryPrefix !== 'string' || !ENTRY_PREFIX_RE.test(d.entryPrefix)) return false;
	if (typeof d.expiresAt !== 'number' || !Number.isFinite(d.expiresAt)) return false;
	if (!isObject(d.theme) || !isObject(d.props)) return false;
	if (d.identity !== null && !isObject(d.identity)) return false;
	if (!Array.isArray(d.capabilities) || !d.capabilities.every((c) => typeof c === 'string')) return false;
	if (!nonEmpty(d.appId) || !nonEmpty(d.appKey) || !nonEmpty(d.moduleId) || typeof d.viewId !== 'string') return false;
	return isEngineHttpUrl(d.engineHttpUrl);
}

/** A window message as the acceptor sees it. */
export interface IInitMessage {
	source: unknown;
	origin: string;
	data: unknown;
	ports?: readonly unknown[];
}

/** Accepts exactly one init from `parent` at one of `origins`. */
export function createInitAcceptor(deps: { origins: readonly string[]; parent: unknown }): { accept(ev: IInitMessage): { init: BridgeInit; port: unknown } | null } {
	let accepted = false;
	const origins = new Set(deps.origins);
	return {
		accept(ev: IInitMessage) {
			if (accepted || !ev || ev.source !== deps.parent || ev.source === null || ev.source === undefined) return null;
			if (typeof ev.origin !== 'string' || !origins.has(ev.origin)) return null;
			if (!Array.isArray(ev.ports) || ev.ports.length !== 1) return null;
			if (!isBridgeInit(ev.data)) return null;
			accepted = true;
			return { init: ev.data, port: ev.ports[0] };
		},
	};
}
