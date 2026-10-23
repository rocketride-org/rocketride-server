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
// SQL BRIDGE — the tool's ONE wiring module (the shell's protocol factories)
// =============================================================================
//
// The sidebar peer keeps ONE live subscriber: whoever subscribed last gets
// every frame call (busPeer.ts). A channel or op server built anywhere else —
// in a render, in a second module — would silently take that slot and every
// call would go unanswered. So this is the only module in the app that
// imports the shell's `createToolChannel`, `createToolOpServer` and
// `createToolController` (a source-reading test pins it), and it does nothing
// but hand them on:
//
//   SQL_TOOL_PROTOCOL   the three factories, injected into the plain wiring
//                       functions (sqlController.ts for the sidebar mount,
//                       sqlFrame.ts for each document frame), which tests run
//                       over the shell's real modules instead;
//   frameChannel        a frame's channel: the host's, else ONE per peer
//                       (never more, whatever re-renders).
//
// The protocol itself (ops, state topics, events) is in ops.ts.
// =============================================================================

import { createToolChannel, createToolController, createToolOpServer } from 'shell';
import type { DevToolProps, ToolChannel } from 'shell';
import { channelFor } from 'shared/explorer/devtool/realm';
import type { SqlToolProtocol } from './sqlFrame';

/** The shell's real protocol factories, for the React mounts. */
export const SQL_TOOL_PROTOCOL: SqlToolProtocol = {
	createToolChannel,
	createToolController,
	createToolOpServer,
};

/**
 * A frame mount's channel: the host's when it gave one, else the one channel
 * built for this peer (cached, so a re-render never builds a second).
 *
 * @param peer - The frame's peer.
 * @param channel - The host's channel, if any.
 * @returns The channel.
 */
export function frameChannel(peer: DevToolProps['peer'], channel: ToolChannel | undefined): ToolChannel {
	return channel ?? channelFor(peer, createToolChannel);
}
