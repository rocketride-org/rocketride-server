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
// VECTOR ENV - THE REACT CONTEXT AND ITS HOOKS
// =============================================================================
//
// Every mount root wraps its subtree in a VectorEnvProvider (the full app,
// the dev-tool sidebar, each dev-tool frame); views read the engine and their
// connection's objects through these hooks. This file imports no shell value
// and nothing that does (`shared/explorer/react` stays in adapters/react.ts,
// the full app's), so a dev-tool frame can load it.
// =============================================================================

import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { IExplorerEndpoint } from 'shared/explorer';
import type { ConsoleTab, IConnectionEntry, IValueStore } from './adapters/connections';
import type { ConsoleModel, SelectionState, VectorChannels } from './contract/types';
import { liveEndpoint } from './env';
import type { IKeyed, IReadable, IVectorEndpointsState, IVectorEnv } from './env';
import { buildConsoleModel } from './vector/consoleModel';
import type { IConsoleState } from './vector/consoleStore';
import { DEFAULT_LIMITS, readDialect } from './vector/results';

const VectorEnvContext = createContext<IVectorEnv | null>(null);

/** The provider every mount root wraps its subtree in. */
export const VectorEnvProvider = VectorEnvContext.Provider;

/**
 * The subtree's env.
 *
 * @returns The env.
 * @throws Error when no provider is mounted (every mount root installs one).
 */
export function useVectorEnv(): IVectorEnv {
	const env = useContext(VectorEnvContext);
	if (!env) throw new Error('useVectorEnv: no VectorEnvProvider above this component.');
	return env;
}

/**
 * Follow a readable.
 *
 * @param readable - The readable.
 * @returns Its value.
 */
export function useReadable<T>(readable: IReadable<T>): T {
	return useSyncExternalStore(readable.subscribe, readable.get, readable.get);
}

/**
 * Follow one key of a keyed value.
 *
 * @param keyed - The keyed value.
 * @param key - The key.
 * @returns Its value for the key.
 */
export function useKeyed<T>(keyed: IKeyed<T>, key: string): T {
	const get = (): T => keyed.get(key);
	return useSyncExternalStore(keyed.subscribe, get, get);
}

/**
 * Follow a value store (an entry's tab, query mode, staged documents, fields).
 *
 * @param store - The store.
 * @returns Its value.
 */
export function useValueStore<T>(store: IValueStore<T>): T {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** @returns Discovered connections and their probes, as this mount sees them. */
export function useEndpointsState(): IVectorEndpointsState {
	return useReadable(useVectorEnv().endpoints);
}

/** @returns The connection the fronted document belongs to. */
export function useEnvActiveConnection(): string | null {
	return useReadable(useVectorEnv().activeConnection);
}

/**
 * The live endpoint for a document (env.ts liveEndpoint): the listed record, else as opened, stopped once a
 * successful discovery no longer lists it.
 *
 * @param opened - The endpoint the document was opened with.
 * @returns The endpoint to show.
 */
export function useLiveEndpoint(opened: IExplorerEndpoint): IExplorerEndpoint {
	const state = useEndpointsState();
	return liveEndpoint(opened, state);
}

/** Everything a console or a document of one connection renders from. */
export interface IConnectionView {
	entry: IConnectionEntry;
	console: IConsoleState;
	selection: SelectionState;
	tab: ConsoleTab;
	chatScope: readonly string[] | null;
	model: ConsoleModel;
	channels: VectorChannels;
}

/**
 * One connection's objects, model and channels in this mount, kept in step with the live endpoint and its probe.
 *
 * @param endpoint - The live endpoint.
 * @returns The view.
 */
export function useConnection(endpoint: IExplorerEndpoint): IConnectionView {
	const env = useVectorEnv();
	const { probes } = useEndpointsState();
	const probe = probes[endpoint.key];
	const limits = (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS;
	const entry = env.connection(endpoint, limits);
	const consoleState = useSyncExternalStore(entry.controller.subscribe, entry.controller.getState, entry.controller.getState);
	const selection = useSyncExternalStore(entry.selection.subscribe, entry.selection.getState, entry.selection.getState);
	const tab = useValueStore(entry.tab);
	const chatScope = useValueStore(entry.chatScope);
	const scope = useValueStore(entry.scope);
	const model = useMemo(() => env.consoleModel({ ...buildConsoleModel(endpoint, probe, consoleState.stats.view), scope }), [env, endpoint, probe, consoleState.stats.view, scope]);
	const channels = useMemo(() => env.channels(endpoint), [env, endpoint]);
	return { entry, console: consoleState, selection, tab, chatScope, model, channels };
}
