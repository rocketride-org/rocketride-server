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
// EXPLORER — ENDPOINT STATE WORDING (the badge each state wears)
// =============================================================================
//
// One place for what an endpoint's state is CALLED, so every Explorer's card
// and drawer say the same thing. The label is the whole message — colour is
// never the only carrier.
// =============================================================================

import type { EndpointState, IExplorerEndpoint } from '../types';

/** A badge variant the shell's connection card accepts. */
export type EndpointBadgeVariant = 'success' | 'muted' | 'error';

/** What each endpoint state looks like on a card. */
export const ENDPOINT_STATE_BADGE: Readonly<Record<EndpointState, { variant: EndpointBadgeVariant; label: string }>> = {
	probing: { variant: 'muted', label: 'Checking' },
	ready: { variant: 'success', label: 'Running' },
	stopped: { variant: 'muted', label: 'Stopped' },
	unreachable: { variant: 'error', label: 'Unreachable' },
	inaccessible: { variant: 'error', label: 'No access' },
};

/**
 * Name the kind of run an endpoint belongs to.
 *
 * @param endpoint - The endpoint.
 * @returns e.g. `Your development run`, `Team deployment`, `Personal deployment`.
 */
export function describeRun(endpoint: Pick<IExplorerEndpoint, 'runKind' | 'ownerKind'>): string {
	if (endpoint.runKind !== 'deploy') return 'Your development run';
	return endpoint.ownerKind === 'team' ? 'Team deployment' : 'Personal deployment';
}
