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
// =============================================================================

import { createHistoryPrefsBridge, useEndpointStoreLifecycle } from 'shared/explorer/react';
import { graphHistory } from './explorer';

export { useEndpointStoreLifecycle };

/** Mount once near the root of the full app: keeps graph history's access to workspace preferences alive. */
export const GraphHistoryPrefsBridge = createHistoryPrefsBridge(graphHistory);
