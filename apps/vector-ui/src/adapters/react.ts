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
// ADAPTER - REACT BINDINGS (the only vector-ui file importing the library's shell-bound modules)
// =============================================================================
//
// `shared/explorer/react` imports values from `shell` (the preference hook,
// the task-event watch), so it is kept out of the pure adapter and imported
// here once. The hooks below subscribe the FULL APP's own sidebar and root to
// the app's stores; every view reads the engine through the env instead
// (envContext.tsx), which a dev-tool frame can load.
// =============================================================================

import { useSyncExternalStore } from 'react';
import { createHistoryPrefsBridge, useEndpointState, useEndpointStoreLifecycle } from 'shared/explorer/react';
import type { IEndpointState } from 'shared/explorer';
import type { IValueStore } from './connections';
import { activeConnection, vectorEndpoints, vectorHistory } from './explorer';

export { useEndpointStoreLifecycle };

/** Mount once near the root: keeps chat history's access to workspace preferences alive. */
export const VectorHistoryPrefsBridge = createHistoryPrefsBridge(vectorHistory);

/**
 * Subscribe to endpoint discovery and probe state.
 *
 * @returns The current snapshot.
 */
export function useVectorEndpoints(): IEndpointState {
	return useEndpointState(vectorEndpoints);
}

/** The active connection's key (the sidebar follows the active document). */
export const useActiveConnection = activeConnection.use;

/**
 * Subscribe to a value store.
 *
 * @param store - The store.
 * @returns Its value.
 */
export function useValue<T>(store: IValueStore<T>): T {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
