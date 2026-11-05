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
// ADAPTER - REACT BINDINGS (the only graph-ui file importing the library's shell-bound modules)
// =============================================================================
//
// `shared/explorer/react` imports values from `shell` (the preference hook, the
// task-event watch), so it is kept out of the pure adapter and imported here once.
// Both bindings are the FULL APP's (GraphApp): the dev-tool mounts keep their
// store wired through the controller (devtool/controller.ts) and never touch the
// workspace prefs. Views read every store through the GraphEnv (env.ts).
//
// History attaches through the page's workspace pin (graph/workspacePin.ts
// pinHistory): after another account signs in without a reload, the prefs the
// shell holds are still the first account's, so the store is given a throwaway
// accessor for anyone else and neither shows nor writes that history.
// =============================================================================

import { createHistoryPrefsBridge, useEndpointStoreLifecycle } from 'shared/explorer/react';
import { pinHistory } from '../graph/workspacePin';
import { graphHistory } from './explorer';

export { useEndpointStoreLifecycle };

/** Graph history's attach, through the page's workspace pin. */
export const pinnedGraphHistory = pinHistory(graphHistory);

/** Mount once near the root of the full app: keeps graph history's access to workspace preferences alive, for the pinned account only. */
export const GraphHistoryPrefsBridge = createHistoryPrefsBridge(pinnedGraphHistory);
