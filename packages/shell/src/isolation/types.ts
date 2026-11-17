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
// ISOLATION TYPES — the contracts of the app-isolation bridge (PR2a)
// =============================================================================
//
// Types only. `IsolatedEntry` is local to PR2a so it does not depend on
// PR2b's `ServerAppEntry` fields.
// =============================================================================

import type { IBusEndpoint } from '../ops/busBridge';
import type { IOpBus } from '../ops/busOps';
import type { IRetainedRegistry } from '../ops/retained';
import type { ConnectionStatus } from '../types/connection';

export type { DenyCode } from './capabilityDenied';

/** One attached realm (one frame of one app). */
export type RealmId = string;

/** The server entry of an isolated app, as the root needs it. */
export interface IsolatedEntry {
	id: string;
	moduleId: string;
	name: string;
	icon?: string;
	registryVersion?: number;
	isolated: true;
	firstParty?: boolean;
}

/** What the root knows about a realm. */
export interface RealmInfo {
	realmId: RealmId;
	/** Diagnostics label (the router's realm label). */
	label: string;
	appId: string;
	appKey: string;
	moduleId: string;
	viewId: string;
	version: number;
	/** Granted capabilities (`core` always included). */
	caps: ReadonlySet<string>;
}

/** What `createGatedBusRouter(...).addGatedRealm` takes per realm. */
export interface RealmContext {
	info: RealmInfo;
	/** The realm's handler bus: inbound requests and emitOps resolve here only. */
	handlers: IOpBus;
	/** Wraps every message posted to the realm (scrub plus backstop). */
	outbound: (message: unknown) => unknown;
}

/** `/apps/frame` 200 answer (Appendix A, plus `frame` and `identity`). */
export interface FrameOk {
	v: 1;
	origin: string;
	entryPrefix: string;
	/** Epoch ms. */
	expiresAt: number;
	capabilities: string[];
	network: string[];
	state: 'ready' | 'internal' | 'submit';
	frame: string;
	identity: { userId: string; organizations: { id: string; name: string }[] } | null;
}

/** What the guest receives in `rr:bridge:init` (PR2a-2 builds it). */
export interface BridgeInit {
	type: 'rr:bridge:init';
	proto: number;
	entryPrefix: string;
	expiresAt: number;
	theme: Record<string, string>;
	identity: { userId: string; displayName: string; organizations: { id: string; name: string }[] } | null;
	props: { isConnected: boolean; activeView: string; activeActivity: string | null; sidePanelOpen: boolean; theme: string };
	capabilities: string[];
	appId: string;
	appKey: string;
	moduleId: string;
	viewId: string;
	engineHttpUrl: string;
}

/** One chip in the frame strip. */
export interface StripItem {
	kind: 'notify' | 'status';
	text: string;
}

/**
 * The slice of `ConnectionManager` the app root uses. Typed structurally so
 * tests pass a fake. (`retained()` is the accessor the implementation adds
 * to the real manager for its private registry.)
 */
export interface IAppRootCm {
	getClient(): unknown;
	isConnected(): boolean;
	ops(): IOpBus;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	on(event: string, handler: (payload: any) => void): () => void;
	emit(event: string, payload: unknown): void;
	loadToken(): string;
	getConnectionStatus(): ConnectionStatus;
	retained(): IRetainedRegistry;
}

/** What the loader hands `attach` besides the entry (defaults apply). */
export interface IRealmGrant {
	viewId?: string;
	version?: number;
	capabilities?: readonly string[];
}

/** Root options. */
export interface IAppRootOptions {
	now(): number;
	random(n: number): Uint8Array;
	fetchFrame(appId: string, version: number): Promise<FrameOk>;
	shellOrigins: readonly string[];
	/** e.g. `http://{label}.apps.localhost:5565`. */
	originTemplate: string;
	ui: {
		strip(realmId: RealmId, item: StripItem): void;
		confirmOpen(realmId: RealmId, url: string): Promise<boolean>;
	};
	openWindow(url: string, target: string, features: string): void;
	log(level: 'debug' | 'info' | 'warn' | 'error', line: string): void;
	/** Test-only: makes the named hook throw (the gate must then fail closed). */
	__throwIn?: 'gate' | 'ledger' | 'outbound';
}

/** The app root. */
export interface IAppRoot {
	/** Throws for a first-party or non-isolated entry. Returns the new realm's id. */
	attach(entry: IsolatedEntry, endpoint: IBusEndpoint, grant?: IRealmGrant): RealmId;
	detach(realmId: RealmId): void;
	/** Terminates live runs, closes fs handles, removes monitors, clears ledgers. */
	teardownAll(timeoutMs: number): Promise<void>;
}
