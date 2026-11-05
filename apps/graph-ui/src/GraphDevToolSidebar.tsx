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
// GRAPH-UI - DEV-TOOL SIDEBAR MOUNT (AppDescriptor.devToolSidebar: the CONTROLLER)
// =============================================================================
//
// A thin React shell over devtool/controller.ts (R6): the controller is built
// in an effect and disposed in its cleanup (never in useMemo: the shell renders
// under StrictMode, which mounts twice), so exactly one op server is live. It
// builds no channel (the host's `channel` is the mount's one transport). Its
// view is the connection list plus the active connection's schema tree, over the
// controller's LOCAL env. The realm's client and connection state come from
// useEngineSource(): a stable getter and a readiness store (waiting, disconnected,
// ready), so the controller is built once and never captures a stale client.
// The first interaction in the sidebar tells the controller a person is present,
// which releases the endpoint probes it holds until then.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionManager } from 'shell';
import type { DevToolProps } from 'shell';
import { useEngineSource } from 'shared/explorer/react';
import { createGraphController } from './devtool/controller';
import type { IGraphController } from './devtool/controller';
import { CONTROLLER_PROTOCOL } from './devtool/wiring';
import { GraphEnvProvider, useReadable } from './env';
import GraphSidebar from './GraphSidebar';

/**
 * The dev-tool sidebar (the controller).
 *
 * @param props - The host's DevToolProps.
 * @returns The sidebar.
 */
export const GraphDevToolSidebar: React.FC<DevToolProps> = ({ channel, documents, activeDocKey }) => {
	const { getClient, readiness } = useEngineSource();
	const [controller, setController] = useState<IGraphController | null>(null);
	// The latest documents API and activeDocKey, for a controller built once per channel.
	const latest = useRef({ documents, activeDocKey });
	latest.current = { documents, activeDocKey };

	useEffect(() => {
		const created = createGraphController({
			cm: ConnectionManager.getInstance(),
			channel,
			getClient,
			readiness,
			documents: {
				open: (key, title) => latest.current.documents?.open(key, title),
				close: (key) => latest.current.documents?.close(key),
			},
			activeDocKey: latest.current.activeDocKey,
			...CONTROLLER_PROTOCOL,
		});
		setController(created);
		return () => {
			created.dispose();
			setController((current) => (current === created ? null : current));
		};
	}, [channel, getClient, readiness]);

	useEffect(() => {
		controller?.noteActiveDocKey(activeDocKey);
	}, [controller, activeDocKey]);

	if (!controller) return null;
	return <SidebarBody controller={controller} />;
};

/** The sidebar's body: the env follows the engine status; the first interaction marks a person present. */
const SidebarBody: React.FC<{ controller: IGraphController }> = ({ controller }) => {
	const status = useReadable(controller.engineStatus);
	const env = useMemo(() => controller.env(status), [controller, status]);
	const present = (): void => controller.discovery.markUserPresent('user');
	return (
		<GraphEnvProvider value={env}>
			<div style={{ display: 'contents' }} onPointerDownCapture={present} onKeyDownCapture={present}>
				<GraphSidebar devtool />
			</div>
		</GraphEnvProvider>
	);
};

export default GraphDevToolSidebar;
