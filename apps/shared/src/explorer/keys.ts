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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER — ENDPOINT KEYS (owner-aware identity, and the one legacy bridge)
// =============================================================================
//
// SQL Explorer's pre-v1 key was `projectId:source:nodeId`. That makes a
// developer's own run and the team's deployment of the same pipeline collide,
// and makes two owners' runs of one project indistinguishable. The v1 key adds
// everything that distinguishes a run:
//
//   k1|runKind|ownerKind|ownerId|teamId|projectId|role=source,role=source|nodeId
//
// Every field is percent-encoded, so the key never contains a raw ':' or '|'
// and a field can never fake a separator. That property is what keeps the
// documents' "strip one trailing :segment" address rule sound.
//
// A TASK TOKEN IS NEVER PART OF A KEY, in any form (not a prefix, not a hash):
// keys are persisted in workspace preferences, put in document URIs and logged.
// =============================================================================

import type { IRoleDef } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Version tag of the key format; a future format changes it. */
export const KEY_VERSION = 'k1';

/** The field separator (percent-encoded inside fields). */
const SEP = '|';

// =============================================================================
// ENCODING
// =============================================================================

/**
 * Percent-encode one field so it can never contain ':' or '|'.
 *
 * @param value - The raw field.
 * @returns The encoded field.
 */
export function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

/**
 * Decode one field; a malformed escape reads as the raw text instead of
 * throwing, because a key can come back from a hand-edited preferences file.
 *
 * @param value - The encoded field.
 * @returns The decoded field.
 */
function decodeSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

// =============================================================================
// BUILD
// =============================================================================

/** What identifies one endpoint. */
export interface IEndpointKeyParts {
	/** 'dev' | 'deploy'. */
	runKind: string;
	/** 'user' | 'team'. */
	ownerKind: string;
	/** The owner's id. */
	ownerId: string;
	/** The owning/billing team id ('' when none). */
	teamId: string;
	/** The project id ('' when the pipeline carries none). */
	projectId: string;
	/** Role name -> source id ('' when the role has no fixed source and is not bound). */
	roles: Readonly<Record<string, string>>;
	/** The tool node's component id. */
	nodeId: string;
}

/**
 * The source a role contributes to a key.
 *
 * A BOUND role contributes the source that fills it, because distinct sources
 * are distinct connections. An UNBOUND role contributes its single declared
 * source when it has exactly one, so a connection's key does not change when
 * one of its sources starts or stops (a Vector connection's key must survive
 * `ingest_1` coming and going), and '' otherwise.
 *
 * @param def - The role definition.
 * @param bound - The source bound to the role right now, or null.
 * @returns The source to put in the key.
 */
export function roleKeySource(def: IRoleDef, bound: string | null): string {
	if (bound !== null) return bound;
	return def.sources !== null && def.sources.length === 1 ? (def.sources[0] as string) : '';
}

/**
 * Build the owner-aware key of an endpoint.
 *
 * @param parts - What identifies the endpoint.
 * @returns The key.
 */
export function buildEndpointKey(parts: IEndpointKeyParts): string {
	const bindings = Object.keys(parts.roles)
		.sort()
		.map((role) => `${encodeSegment(role)}=${encodeSegment(parts.roles[role] as string)}`)
		.join(',');
	return [
		KEY_VERSION,
		encodeSegment(parts.runKind),
		encodeSegment(parts.ownerKind),
		encodeSegment(parts.ownerId),
		encodeSegment(parts.teamId),
		encodeSegment(parts.projectId),
		bindings,
		encodeSegment(parts.nodeId),
	].join(SEP);
}

// =============================================================================
// PARSE
// =============================================================================

/**
 * Take a key apart again.
 *
 * @param key - A key built by {@link buildEndpointKey}.
 * @returns Its parts, or null when the text is not a v1 key.
 */
export function parseEndpointKey(key: string): IEndpointKeyParts | null {
	const fields = key.split(SEP);
	if (fields.length !== 8 || fields[0] !== KEY_VERSION) return null;
	const roles: Record<string, string> = {};
	const bindings = fields[6] as string;
	if (bindings !== '') {
		for (const pair of bindings.split(',')) {
			const cut = pair.indexOf('=');
			if (cut < 0) return null;
			roles[decodeSegment(pair.slice(0, cut))] = decodeSegment(pair.slice(cut + 1));
		}
	}
	return {
		runKind: decodeSegment(fields[1] as string),
		ownerKind: decodeSegment(fields[2] as string),
		ownerId: decodeSegment(fields[3] as string),
		teamId: decodeSegment(fields[4] as string),
		projectId: decodeSegment(fields[5] as string),
		roles,
		nodeId: decodeSegment(fields[7] as string),
	};
}

// =============================================================================
// LEGACY BRIDGE
// =============================================================================

/**
 * SQL Explorer's pre-v1 key for the same connection, or null when the old key
 * could not have meant it.
 *
 * Only the CALLER'S OWN DEV RUN qualifies: the old discovery resolved tokens
 * through a lookup that opened only the caller's own dev run, so that is the
 * one thing a saved `projectId:source:nodeId` ever referred to. A deployment, a
 * team's run, or a task without a project id gets null, so saved history is
 * never read across owners or across dev and deploy.
 *
 * Pure function of the key (it needs no identity: getTasks lists only the
 * caller's own user-owned runs), so a persisted key can be bridged without the
 * endpoint that produced it.
 *
 * @param key - A v1 endpoint key.
 * @returns The legacy key, or null.
 */
export function legacyKeyFromKey(key: string): string | null {
	const parts = parseEndpointKey(key);
	if (parts === null) return null;
	if (parts.runKind !== 'dev' || parts.ownerKind !== 'user' || parts.projectId === '') return null;
	const sources = Object.values(parts.roles).filter((source) => source !== '');
	// The old key had exactly one source; a multi-role connection has no old twin.
	if (Object.keys(parts.roles).length !== 1 || sources.length !== 1) return null;
	return `${parts.projectId}:${sources[0] as string}:${parts.nodeId}`;
}
