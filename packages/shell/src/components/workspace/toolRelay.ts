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
// TOOL RELAY CONSTANTS — the peer contract's shared wire facts
// =============================================================================
//
// The relay POLICY that used to live here (one copy, run inside each host's
// transport bridge) is retired: the peer rides the shell bus's retained/
// signal lanes now — see busPeer.ts, where every policy rule is a lane
// choice. This module keeps only the wire facts both busPeer and the
// tool-facing protocol surface (toolProtocol.ts) share.
// =============================================================================

import type { IToolStateMessage } from './toolChannel';

/** Wire name of the host connection topic (see toolProtocol.ts for the
 *  tool-facing surface; defined here so non-browser host processes get it
 *  without the React import chain). */
export const HOST_CONNECTION_TOPIC = 'host:connection';

/**
 * The host-published `host:connection` state envelope — the ONE wire shape
 * both in-browser hosts (publishHostConnectionState) and the VS Code
 * extension host deliver.
 *
 * @param connected - Whether the host's server connection is up.
 * @returns The state message.
 */
export function hostConnectionPayload(connected: boolean): IToolStateMessage {
	return { __rrtool: 'state', topic: HOST_CONNECTION_TOPIC, snapshot: { connected } };
}

/** Most buffered payloads kept per direction (oldest evicted past this). */
export const TOOL_RELAY_BUFFER_LIMIT = 64;
