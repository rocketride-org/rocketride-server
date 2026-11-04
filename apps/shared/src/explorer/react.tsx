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
// EXPLORER — REACT / SHELL BINDINGS (the components that need the platform)
// =============================================================================
//
// The only place besides shellBinding.ts where the library imports a VALUE from
// 'shell'. Everything it binds (the history store, the announcer) is pure and
// tested without the platform; these wrappers are the thin seams onto it.
// =============================================================================

import React, { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAuthUser, usePrefs, useShellConnection } from 'shell';
import { identityFingerprint, identityFromConnectResult } from './connect/identity';
import type { IEndpointState, IEndpointStore } from './connect/store';
import type { IPrefsAccessor } from './history/types';
import { createExplorerClient } from './devtool/engineClient';
import type { IRealmClient, RealmClientGetter } from './devtool/engineClient';
import { createEngineReadiness, engineStatus } from './devtool/readiness';
import type { EngineStatus, IEngineReadiness } from './devtool/readiness';
import { createShellWatch } from './shellBinding';
import type { IExplorerClient } from './types';

/** The part of a history store the bridge needs. */
export interface IPrefsAttachable {
	/** Attach the preference accessor under its owner (the identity fingerprint); returns the detach function. */
	attachPrefs(api: IPrefsAccessor, owner?: string | null): () => void;
}

/**
 * Create the component that mounts a history store's access to workspace
 * preferences.
 *
 * It renders nothing. Mount it wherever the app is on screen and history
 * should be kept — the app root does, and a History drawer may mount its own so
 * the drawer works even from a query document whose connection tab was closed.
 * Multiple mounts are safe: attachment is reference-counted.
 *
 * It attaches under the signed-in identity's fingerprint, and attaches again
 * when that changes, so the store drops a previous account's history before
 * the next account sees, merges or saves any of it (history/store.ts, "WHOSE
 * HISTORY IS IN MEMORY"). A layout effect, so a render that carries the new
 * identity is never painted with the old history.
 *
 * @param store - The app's history store.
 * @returns A null-rendering component.
 */
export function createHistoryPrefsBridge(store: IPrefsAttachable): React.FC {
	const HistoryPrefsBridge: React.FC = () => {
		const api = usePrefs();
		const owner = identityFingerprint(identityFromConnectResult(useAuthUser()));

		// The shell hands out a NEW accessor object whenever any preference
		// changes; the store needs one stable identity for the mount's lifetime,
		// so calls are forwarded through a ref instead.
		const latest = useRef(api);
		latest.current = api;

		const stable = useMemo<IPrefsAccessor>(() => ({
			getPref: (key: string) => latest.current.getPref(key),
			setPref: (key: string, value: unknown) => latest.current.setPref(key, value),
		}), []);

		useLayoutEffect(() => store.attachPrefs(stable, owner), [stable, owner]);

		return null;
	};
	return HistoryPrefsBridge;
}

/**
 * Subscribe to an endpoint store's snapshot.
 *
 * @param store - The app's endpoint store.
 * @returns The current snapshot (stable until the store changes).
 */
export function useEndpointState(store: IEndpointStore): IEndpointState {
	return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * Keep an endpoint store wired to the platform for as long as the calling
 * component is mounted: task events, window focus, reconnects and — the part
 * that keeps one organization's connections out of the next session — identity
 * changes and sign-out.
 *
 * Mount it once at the app root with the shell's own props. The store is
 * re-attached only when the CLIENT or the identity FINGERPRINT changes (user,
 * organization, development team — never a token, never a permission list).
 *
 * @param store - The app's endpoint store.
 * @param client - The shell's client (null while disconnected).
 * @param identity - The shell's `identity` prop (a ConnectResult, or null when signed out).
 */
export function useEndpointStoreLifecycle(store: IEndpointStore, client: IExplorerClient | null, identity: unknown): void {
	const latest = identityFromConnectResult(identity);
	const fingerprint = identityFingerprint(latest);
	const latestRef = useRef(latest);
	latestRef.current = latest;

	useEffect(() => {
		if (client === null) return undefined;
		return store.attach(client, latestRef.current, createShellWatch(client));
		// `fingerprint` stands in for the identity: a new object with the same
		// user, organization and team must not re-attach.
	}, [store, client, fingerprint]);
}

/** What {@link useRealmEngine} returns. */
export interface IRealmEngine {
	/** `waiting` (no client yet), `disconnected`, or `ready`. */
	status: EngineStatus;
	/** The engine client, only while `status` is `ready`; one stable instance per realm client. */
	client: IExplorerClient | null;
}

/**
 * The realm's engine access: the realm's own RocketRideClient
 * (`useShellConnection().client`: the root's, or the proxy riding the shell
 * bus), narrowed to the library's client and gated on the realm's readiness.
 * It never infers what the realm owns from having a client.
 *
 * The adapter reads the latest client through a ref at call time, so a request
 * in flight when the client is replaced is never sent through a stale one; the
 * returned `client` is null unless the status is `ready`.
 *
 * @returns The status and, when ready, the client.
 */
export function useRealmEngine(): IRealmEngine {
	const { client: raw, isConnected } = useShellConnection();
	const latest = useRef<IRealmClient | null>(null);
	latest.current = raw as unknown as IRealmClient | null;
	const adapter = useMemo(() => createExplorerClient(() => latest.current), []);
	const status = engineStatus({ client: raw, isConnected });
	return useMemo(() => ({ status, client: status === 'ready' ? adapter : null }), [status, adapter]);
}

/** What {@link useEngineSource} returns. */
export interface IEngineSource {
	/** The realm's client right now (null until the realm has one); one stable function. */
	getClient: RealmClientGetter<IRealmClient>;
	/** The realm's engine readiness, kept current; one stable store. */
	readiness: IEngineReadiness;
}

/**
 * The realm's engine source for a controller that is built once, in an effect:
 * a stable getter over the latest `useShellConnection().client` and a stable
 * readiness store fed from the same hook. Neither changes identity across
 * renders, so a controller (and every adapter made from `getClient`) is not
 * rebuilt when the client or the connection changes: each call reads the
 * getter again, and discovery follows the readiness store.
 *
 * The getter returns the client whenever the realm has one, connected or not;
 * `readiness` says whether engine requests may be sent.
 *
 * @returns The getter and the readiness store.
 */
export function useEngineSource(): IEngineSource {
	const { client, isConnected } = useShellConnection();
	const latest = useRef<IRealmClient | null>(null);
	latest.current = client as unknown as IRealmClient | null;
	const source = useMemo<IEngineSource>(() => ({
		getClient: () => latest.current,
		readiness: createEngineReadiness({ client: latest.current, isConnected }),
	}), []); // eslint-disable-line react-hooks/exhaustive-deps
	useLayoutEffect(() => {
		source.readiness.set({ client, isConnected });
	}, [source, client, isConnected]);
	return source;
}
