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
// CONNECT — SQL EXPLORER'S ENDPOINT STORE (the shared store, SQL's options)
// =============================================================================
//
// The library's endpoint store (shared/explorer/connect/store) with SQL
// Explorer's provider set, its single `tools` role and its tool table. It owns
// discovery, the one probe per endpoint and the task-token VAULT: a task token
// lives only inside the store, so nothing an endpoint, a snapshot or a
// session hands out can carry one.
//
// A FACTORY, not a module instance: the engine core (sqlCore.ts) creates one
// per owner — the full app's mount, or the dev tool's controller — so a full
// app and a dev-tool controller in one realm never share discovery, tokens or
// sessions.
// =============================================================================

import { createEndpointStore } from 'shared/explorer/connect/store';
import type { IEndpointStore, IStoreClock } from 'shared/explorer/connect/store';
import { SINGLE_TOOLS_ROLE } from 'shared/explorer/types';
import { DATABASE_PROVIDERS } from './discovery';
import { SQL_TOOLS } from './tools';

/**
 * Create SQL Explorer's endpoint store.
 *
 * @param opts - Optional clock (tests).
 * @returns The store.
 */
export function createSqlEndpoints(opts: { clock?: IStoreClock } = {}): IEndpointStore {
	return createEndpointStore({
		providers: DATABASE_PROVIDERS,
		roles: SINGLE_TOOLS_ROLE,
		tools: SQL_TOOLS,
		...(opts.clock ? { clock: opts.clock } : {}),
	});
}
