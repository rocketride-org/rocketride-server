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
// NODES TOOL — the builtin nodes tool's CONTROLLER
// =============================================================================

import React, { useEffect, useState } from 'react';
import { ConnectionManager } from 'shell';
import type { DevToolProps } from 'shell';
import { useToolHost } from '../core/ToolContext';
import { NodesSidebarPanel } from './NodesSidebarPanel';
import type { IntroMode } from '../introCatalog';
import { pickNodePackage, uploadNodePackage } from './nodeRail';

/** The published nodes in the caller's catalogue: a published node's id holds a dot. */
function publishedNodes(services: Record<string, unknown>): Array<{ id: string; title: string }> {
	return Object.entries(services)
		.filter(([id]) => id.includes('.'))
		.map(([id, service]) => ({ id, title: (service as { title?: string })?.title || id }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** The nodes tool's sidebar controller. */
export const NodesTool: React.FC<DevToolProps> = ({ documents, activeDocKey }) => {
	const services = useToolHost();
	const cm = ConnectionManager.getInstance();
	const [nodes, setNodes] = useState(() => publishedNodes(cm.getCachedServices().services));
	const [error, setError] = useState('');
	useEffect(() => cm.on('shell:servicesUpdated', () => setNodes(publishedNodes(cm.getCachedServices().services))), [cm]);

	/** Choose a .rrnode, upload it as a version, and open its node. */
	const onUpload = (): void => {
		setError('');
		void pickNodePackage()
			.then(async (data) => {
				if (!data) return;
				const nodeId = await uploadNodePackage(cm, data);
				documents?.open(nodeId, nodeId);
			})
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	};

	return <NodesSidebarPanel nodes={nodes} activeNodeId={activeDocKey?.startsWith('tool:nodes/') ? activeDocKey.slice('tool:nodes/'.length) : undefined} onOpenNode={documents ? (nodeId, title) => documents.open(nodeId, title) : undefined} onUpload={documents ? onUpload : undefined} error={error} onShowIntro={(mode: IntroMode) => services.openPage(`intro:${mode}`)} />;
};
