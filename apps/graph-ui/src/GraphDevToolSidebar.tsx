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
// never subscribes the peer itself. Its view is the connection list plus the
// active connection's schema tree, over the controller's LOCAL env; the realm's
// connection flag is the mirrored `useShellConnection().isConnected` (a sidebar
// cannot read `host:connection`).
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionManager, useShellConnection } from 'shell';
import type { DevToolProps } from 'shell';
import { createGraphController } from './devtool/controller';
import type { IGraphController, IGraphRealm } from './devtool/controller';
import { CONTROLLER_PROTOCOL } from './devtool/wiring';
import { GraphEnvProvider } from './env';
import GraphSidebar from './GraphSidebar';

/**
 * The dev-tool sidebar (the controller).
 *
 * @param props - The host's DevToolProps.
 * @returns The sidebar.
 */
export const GraphDevToolSidebar: React.FC<DevToolProps> = ({ peer, channel, documents, activeDocKey }) => {
	const { isConnected } = useShellConnection();
	const [controller, setController] = useState<IGraphController | null>(null);
	// The latest documents API and activeDocKey, for a controller built once per peer.
	const latest = useRef({ documents, activeDocKey });
	latest.current = { documents, activeDocKey };

	useEffect(() => {
		const realm: IGraphRealm = ConnectionManager.getInstance();
		const created = createGraphController({
			cm: realm,
			peer,
			...(channel ? { channel } : {}),
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
	}, [peer, channel]);

	useEffect(() => {
		controller?.noteActiveDocKey(activeDocKey);
	}, [controller, activeDocKey]);

	const env = useMemo(() => (controller ? controller.env(isConnected) : null), [controller, isConnected]);
	if (!env) return null;
	return (
		<GraphEnvProvider value={env}>
			<GraphSidebar devtool />
		</GraphEnvProvider>
	);
};

export default GraphDevToolSidebar;
