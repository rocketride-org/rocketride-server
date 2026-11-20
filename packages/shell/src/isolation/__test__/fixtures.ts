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
// FIXTURES — entries, a fake clock, and a ready-made root
// =============================================================================

/// <reference types="node" />

import { createHash, randomBytes } from 'node:crypto';
import { createAppRoot } from '../appRoot';
import type { FrameOk, IAppRoot, IAppRootOptions, IsolatedEntry, StripItem } from '../types';
import { createFakeCm } from './fakeCm';
import type { IFakeCm } from './fakeCm';
import { openRealm } from './realm';
import type { IOpenedRealm, IOpenRealmOptions } from './realm';

export const ENTRY_A: IsolatedEntry = { id: 'acme.alpha', moduleId: 'acme_alpha', name: 'Alpha', registryVersion: 1, isolated: true };
export const ENTRY_B: IsolatedEntry = { id: 'acme.beta', moduleId: 'acme_beta', name: 'Beta', registryVersion: 1, isolated: true };
/** First-party: no `isolated` flag, `firstParty: true` (the root must refuse it). */
export const ENTRY_FIRST_PARTY = { id: 'rocketride.home', moduleId: 'rocketride_home', name: 'Home', registryVersion: 1, firstParty: true } as unknown as IsolatedEntry;

/** Real-format credentials for assertions. */
export const RE = {
	realToken: /\btk_[0-9a-f]{32}\b/,
	realPublic: /\bpk_[0-9a-f]{32}\b/,
	handle: /^rh_[A-Za-z0-9_-]{22}$/,
	projectAlias: /^rp_[A-Za-z0-9_-]{22}$/,
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The test's own reference for the app key (`label_of`, `app_origin.py:340`):
 * `a` + the first 24 chars of the lowercase unpadded base32 of sha256(id).
 * Independent of the production `appKeyOf` (still a stub in commit A), so
 * path and namespace tests do not depend on it. T18 and T50 pin both to the
 * shared vector file.
 */
export function refAppKey(appId: string): string {
	const digest = createHash('sha256').update(appId, 'utf8').digest();
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of digest) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return `a${out.slice(0, 24)}`;
}

/** A hand-advanced clock (the tests' only notion of time). */
export interface IFakeClock {
	now(): number;
	advance(ms: number): void;
}

export function createFakeClock(start = 1_700_000_000_000): IFakeClock {
	let t = start;
	return {
		now: () => t,
		advance(ms) {
			t += ms;
		},
	};
}

/** A ready-made root with spies on every option. */
export interface ITestRoot {
	cm: IFakeCm;
	root: IAppRoot;
	opts: IAppRootOptions;
	clock: IFakeClock;
	logs: string[];
	strips: Array<{ realmId: string; item: StripItem }>;
	confirms: Array<{ realmId: string; url: string }>;
	opened: Array<{ url: string; target: string; features: string }>;
	fetches: Array<{ appId: string; version: number }>;
	/** What `ui.confirmOpen` answers (default false). */
	confirmAnswer: { value: boolean };
	/** Opens a realm and closes it at cleanup. */
	open(entry?: IsolatedEntry, options?: IOpenRealmOptions): IOpenedRealm;
	cleanup(): void;
}

/** Builds a root over a fresh fake manager. `extra` overrides root options. */
export function makeRoot(extra: Partial<IAppRootOptions> = {}): ITestRoot {
	const cm = createFakeCm();
	const clock = createFakeClock();
	const logs: string[] = [];
	const strips: ITestRoot['strips'] = [];
	const confirms: ITestRoot['confirms'] = [];
	const opened: ITestRoot['opened'] = [];
	const fetches: ITestRoot['fetches'] = [];
	const confirmAnswer = { value: false };
	const realms: IOpenedRealm[] = [];
	const opts: IAppRootOptions = {
		now: clock.now,
		random: (n) => new Uint8Array(randomBytes(n)),
		async fetchFrame(appId, version): Promise<FrameOk> {
			fetches.push({ appId, version });
			return {
				v: 1,
				origin: `http://${refAppKey(appId)}.apps.localhost:5565`,
				entryPrefix: `/_t/frametoken-${fetches.length}/v${version}/`,
				expiresAt: clock.now() + 900_000,
				capabilities: ['core', 'pipelines.run', 'fs.app'],
				network: [],
				state: 'ready',
				frame: '/_rr/frame.html?c=ticket',
				identity: null,
			};
		},
		shellOrigins: ['http://localhost:5565'],
		originTemplate: 'http://{label}.apps.localhost:5565',
		ui: {
			strip: (realmId, item) => void strips.push({ realmId, item }),
			confirmOpen: async (realmId, url) => {
				confirms.push({ realmId, url });
				return confirmAnswer.value;
			},
		},
		openWindow: (url, target, features) => void opened.push({ url, target, features }),
		log: (level, line) => void logs.push(`${level} ${line}`),
		...extra,
	};
	const root = createAppRoot(cm, opts);
	return {
		cm,
		root,
		opts,
		clock,
		logs,
		strips,
		confirms,
		opened,
		fetches,
		confirmAnswer,
		open(entry = ENTRY_A, options) {
			const realm = openRealm(root, entry, options);
			realms.push(realm);
			return realm;
		},
		cleanup() {
			for (const realm of realms) realm.close();
			realms.length = 0;
		},
	};
}
