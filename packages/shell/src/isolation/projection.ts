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
// PROJECTION — the `rr:bridge:init` message built from allowlisted inputs (PR2a-2)
// =============================================================================
//
// Every key is copied by name from an allowlisted input (plan section 4.1):
// the frame grant gives `entryPrefix` (the frame token, the one N1 exemption,
// plan section 4.4), `expiresAt` and the identity aliases the server minted;
// nothing else of the grant (origin, ticket, network) is part of the init.
// The root never computes an identity alias: it copies the grant's, and only
// when it has the alias shapes (`ru_`, `ro_`); anything else gives
// `identity: null` (DA F7). Every string but `entryPrefix` then passes the
// backstop patterns (an engine-format credential, a minted `rrapp.` id): a hit
// throws a `credential` denial, so no init is posted. PR2b must still post
// the init through the realm's choke point (plan, PR2b notes).
// =============================================================================

import { deny } from './denial';
import type { BridgeInit, FrameOk, RealmInfo } from './types';

const USER_ALIAS_RE = /^ru_[A-Za-z0-9_-]+$/;
const ORG_ALIAS_RE = /^ro_[A-Za-z0-9_-]+$/;
/** The backstop patterns (scrub.ts): an engine-format credential, a minted project id. */
const INIT_BACKSTOP_RE = /(?<![A-Za-z0-9])(?:tk|pk)_[0-9a-fA-F]{32}|(?<![A-Za-z0-9.])rrapp\.[a-z2-7]{25}\.[0-9a-f-]{36}/;

/** Throws when any string (value or key) of `value` hits the backstop patterns. */
function backstop(value: unknown): void {
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const v = stack.pop();
		if (typeof v === 'string') {
			if (INIT_BACKSTOP_RE.test(v)) throw deny('credential', 'rr:bridge:init');
		} else if (typeof v === 'object' && v !== null) {
			for (const [k, x] of Object.entries(v)) {
				if (INIT_BACKSTOP_RE.test(k)) throw deny('credential', 'rr:bridge:init');
				stack.push(x);
			}
		}
	}
}

/** The grant's identity when it carries alias shapes only; otherwise null. */
function identityOf(identity: FrameOk['identity']): FrameOk['identity'] {
	if (!identity || typeof identity.userId !== 'string' || !USER_ALIAS_RE.test(identity.userId) || !Array.isArray(identity.organizations)) return null;
	if (!identity.organizations.every((o) => typeof o?.id === 'string' && ORG_ALIAS_RE.test(o.id))) return null;
	return identity;
}

/** Everything `buildBridgeInit` reads. */
export interface IBridgeInitInput {
	info: RealmInfo;
	frame: FrameOk;
	displayName: string;
	theme: Record<string, string>;
	props: BridgeInit['props'];
	engineHttpUrl: string;
	proto: number;
}

/**
 * Builds the guest's `rr:bridge:init`.
 *
 * @param input - The realm, its frame grant and the shell's view of the session.
 * @returns The message, with exactly the `BridgeInit` keys.
 * @throws A `credential` denial when a string other than `entryPrefix` hits the backstop.
 */
export function buildBridgeInit(input: IBridgeInitInput): BridgeInit {
	const { info, frame, props } = input;
	const identity = identityOf(frame.identity);
	const theme: Record<string, string> = {};
	for (const [k, v] of Object.entries(input.theme)) if (typeof v === 'string') theme[k] = v;
	const init: BridgeInit = {
		type: 'rr:bridge:init',
		proto: input.proto,
		entryPrefix: frame.entryPrefix,
		expiresAt: frame.expiresAt,
		theme,
		identity: identity ? { userId: identity.userId, displayName: input.displayName, organizations: identity.organizations.map((o) => ({ id: o.id, name: o.name })) } : null,
		props: { isConnected: props.isConnected, activeView: props.activeView, activeActivity: props.activeActivity, sidePanelOpen: props.sidePanelOpen, theme: props.theme },
		capabilities: [...info.caps],
		appId: info.appId,
		appKey: info.appKey,
		moduleId: info.moduleId,
		viewId: info.viewId,
		engineHttpUrl: input.engineHttpUrl,
	};
	// entryPrefix holds the frame token, the one deliberate exemption (plan section 4.4).
	backstop({ ...init, entryPrefix: '' });
	return init;
}
