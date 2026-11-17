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
// APP ROOT — PR2a-1 red-before PASS-THROUGH STUB
// =============================================================================
//
// An UNGATED router over the real client ops: no checks, no handles, no
// `shell.*` ops, no events. It exists so the PR2a-1 tests fail on their
// behavioural assertions, never on an import error. The implementation
// commit replaces it. Nothing outside `src/isolation/` may import this file.
// =============================================================================

import { createBusRouter } from '../ops/busBridge';
import type { IBusEndpoint } from '../ops/busBridge';
import { createOpBus } from '../ops/busOps';
import { registerClientOps } from '../ops/clientOps';
import type { IAppRoot, IAppRootCm, IAppRootOptions, IRealmGrant, IsolatedEntry, RealmId } from './types';

/**
 * Creates the app root (pass-through stub).
 *
 * @param cm - The slice of the ConnectionManager the root uses.
 * @param _opts - Root options (unused by the stub).
 * @returns The root.
 */
export function createAppRoot(cm: IAppRootCm, _opts: IAppRootOptions): IAppRoot {
	const bus = createOpBus();
	registerClientOps(bus, cm);
	const router = createBusRouter(bus, { retained: cm.retained() });
	let seq = 0;
	return {
		attach(entry: IsolatedEntry, endpoint: IBusEndpoint, _grant?: IRealmGrant): RealmId {
			const realmId = `realm-${++seq}`;
			router.addRealm(endpoint, entry.id);
			return realmId;
		},
		detach(): void {},
		async teardownAll(): Promise<void> {},
	};
}
