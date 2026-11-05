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
// GRAPH-UI - CONNECTION DRAWER (inspect and test one graph endpoint)
// =============================================================================
//
// Shows what the node says about itself (engine, version, graph or database,
// whether writes are allowed, how reads are kept read-only) and the endpoint's own
// pipeline, run kind and owner. "Test connection" asks the node's `dialect` tool
// again through the shared store; nothing here holds or shows a credential.
//
// The full app opens it from a Connections card, over the window. A dev-tool
// document shows the same body inline instead (ConnectionDetailsPanel).
// =============================================================================

import React from 'react';
import { Button, DetailPanel } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { connectionView } from '../graph/connections';
import { GraphIcon } from '../icons';
import { ConnectionDetailsBody, useConnectionTest } from './ConnectionDetails';

/** Props. */
export interface IConnectionDrawerProps {
	open: boolean;
	endpoint: IExplorerEndpoint | null;
	probe: IProbeResult | undefined;
	/** Re-probe the endpoint; resolves with the new result (null when nothing was sent: no running task, or a check already running). */
	onTest(endpoint: IExplorerEndpoint): Promise<IProbeResult | null>;
	onOpen(endpoint: IExplorerEndpoint): void;
	onClose(): void;
}

/**
 * The drawer.
 *
 * @param props - See {@link IConnectionDrawerProps}.
 * @returns The drawer, or nothing while closed.
 */
export const ConnectionDrawer: React.FC<IConnectionDrawerProps> = ({ open, endpoint, probe, onTest, onOpen, onClose }) => {
	// The host keys this drawer on the card it shows, so a result never carries over to another connection.
	const { testing, tested, test } = useConnectionTest(onTest);
	if (!endpoint) return null;
	const view = connectionView(endpoint, probe);

	return (
		<DetailPanel
			open={open}
			onClose={onClose}
			avatar={<GraphIcon />}
			title={view.title}
			subtitle={view.address}
			footer={
				<>
					<Button variant="ghost" disabled={testing} onClick={() => void test(endpoint)}>
						{testing ? 'Testing...' : 'Test connection'}
					</Button>
					<Button variant="primary" disabled={!view.openable} onClick={() => onOpen(endpoint)}>
						Open workbench
					</Button>
				</>
			}
		>
			<ConnectionDetailsBody endpoint={endpoint} probe={probe} tested={tested} />
		</DetailPanel>
	);
};

export default ConnectionDrawer;
