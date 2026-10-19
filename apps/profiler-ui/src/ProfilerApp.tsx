// MIT License
//
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
// PROFILER APP — Main client area component
// =============================================================================
//
// The profiler ALWAYS targets the host's connected engine (the shell
// connection singleton) — the per-connection landing page, saved-connection
// store, and document tabs are gone (2026-10-14). One surface: the profiler
// frame (viz + stats) in the content area, with every control in the
// sidebar panel, the two joined by the profilerBridge channel.
// =============================================================================

import React, { useEffect, useMemo } from 'react';
import type { DevToolProps, ShellAppProps } from 'shell';
import { ConnectionManager, AppLayout, createToolChannel, createToolController, useConnectionReady, useShellConnection } from 'shell';
import ProfilerView from './views/ProfilerView';
import ProfilerSidebar from './ProfilerSidebar';
import { localFrameChannel, createPeerFrameChannel } from './profilerBridge';
import { callProfilerOp } from './ops';
import type { ProfilerEngine, ProfilerOps } from './ops';

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Profiler app — the profiler frame inside the app chrome, with the control
 * panel in the sidebar. Both ends share the in-document channel.
 */
const ProfilerApp: React.FC<ShellAppProps> = (_props) => {
	const { isConnected } = useShellConnection();
	// The LOCAL engine over the SHELL BUS — named client.* ops, no client
	// object in this realm.
	const engine = useMemo<ProfilerEngine>(() => {
		const cm = ConnectionManager.getInstance();
		return {
			ready: isConnected,
			call: <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
				if (!cm.isConnected()) return Promise.reject(new Error('Not connected to a server.'));
				return callProfilerOp<T>((op, params) => cm.request(op, params), command, args);
			},
		};
	}, [isConnected]);
	return (
		<AppLayout sidebar={<ProfilerSidebar />} showStatus>
			<ProfilerView channel={localFrameChannel} engine={engine} />
		</AppLayout>
	);
};

// =============================================================================
// DEV-TOOL FRAME — the profiler without shell chrome
// =============================================================================

/**
 * Dev-tool frame — the profiler surface without the shell AppLayout chrome,
 * for host workbenches that mount the tool directly (the VS Code dev-tool
 * panel). Controls live in the tool's sidebar mount; the two coordinate over
 * the host-relayed peer channel.
 */
export const ProfilerDevTool: React.FC<DevToolProps> = ({ peer, channel }) => {
	const frameChannel = useMemo(() => createPeerFrameChannel(peer), [peer]);

	// FRAMES HOLD NO ROCKETRIDE CLIENT: commands ride the controller op, and
	// enablement is the host-published `host:connection` system topic.
	const toolChannel = useMemo(() => channel ?? createToolChannel(peer), [channel, peer]);
	const call = useMemo(() => createToolController<ProfilerOps>(peer), [peer]);
	const ready = useConnectionReady(toolChannel);
	const engine = useMemo<ProfilerEngine>(() => ({
		ready,
		call: <T,>(command: string, args?: Record<string, unknown>): Promise<T> =>
			call('profiler.call', { command, ...(args ? { args } : {}) }) as Promise<T>,
	}), [call, ready]);

	return <ProfilerView channel={frameChannel} engine={engine} />;
};

export default ProfilerApp;
