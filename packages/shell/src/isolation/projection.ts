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
// PROJECTION — the `rr:bridge:init` message built from allowlisted inputs (PR2a-2)
// =============================================================================
//
// COMMIT A STUB: returns an empty object. The implementation (plan sections
// 4.1 and 4.4) replaces it.
// =============================================================================

import type { BridgeInit, FrameOk, RealmInfo } from './types';

/** Everything `buildBridgeInit` reads. */
export interface IBridgeInitInput {
	info: RealmInfo;
	frame: FrameOk;
	displayName: string;
	theme: Record<string, string>;
	props: BridgeInit['props'];
	engineHttpUrl: string;
	proto: number;
}

/**
 * Builds the guest's `rr:bridge:init`.
 *
 * @param _input - The realm, its frame grant and the shell's view of the session.
 * @returns The message (an empty object in commit A).
 */
export function buildBridgeInit(_input: IBridgeInitInput): BridgeInit {
	return {} as BridgeInit;
}
