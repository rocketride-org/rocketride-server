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
// SCRUB — what the root rewrites in everything it sends to an app (PR2a-2, N1)
// =============================================================================
//
// COMMIT A STUBS: identity functions that keep PR2a-1's behaviour. The
// implementation (plan section 4.4) replaces them.
// =============================================================================

import type { DAPMessage } from 'rocketride';
import type { IKnownProjects } from './aliases';
import type { IGatedRequest } from './gate';
import type { ILedger } from './ledger';
import type { IRealmGrant } from './types';

/** What the scrubber needs for one realm (stub shape; the implementation may refine it). */
export interface IScrubContext {
	ledger: ILedger;
	known: IKnownProjects;
	grant: IRealmGrant;
	sessionToken(): string;
	apiKeys(): string[];
}

/**
 * Scrubs any value on its way to the realm.
 *
 * @param _ctx - The realm's scrub context.
 * @param value - The value.
 * @returns The value (identity in commit A).
 */
export function scrubOutbound<T>(_ctx: IScrubContext, value: T): T {
	return value;
}

/**
 * Scrubs one `client.request` response (after the ledger recorded it).
 *
 * @param _ctx - The realm's scrub context.
 * @param _req - The gated request it answers.
 * @param response - The engine response.
 * @returns The response (identity in commit A).
 */
export function scrubResponse(_ctx: IScrubContext, _req: IGatedRequest, response: DAPMessage): DAPMessage {
	return response;
}

/**
 * Scrubs one engine event on its way to the realm that owns its run.
 *
 * @param _ctx - The realm's scrub context.
 * @param event - The engine event.
 * @returns The event (identity in commit A).
 */
export function scrubEvent(_ctx: IScrubContext, event: DAPMessage): DAPMessage {
	return event;
}
