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
// TOOLS/NODES — the Node Builder tool's SIDEBAR PANEL (placeholder)
// =============================================================================

import React from 'react';
import { BxNote } from 'shell';
import { CodiconCircuitBoard } from '../../components/icons/Codicon';
import { SidebarMenu } from 'shell';
import type { ViewMenu } from 'shell';
import { panelStyles } from '../core/chrome/panelStyles';
import type { IntroMode } from '../introCatalog';

/** Props for {@link NodesSidebarPanel}. */
export interface INodesSidebarPanelProps {
	/** Open the embedded Introduction page. */
	onShowIntro?: (mode: IntroMode) => void;
	/** The published nodes in the caller's catalogue. */
	nodes?: Array<{ id: string; title: string }>;
	/** The node whose document is active, if any. */
	activeNodeId?: string;
	/** Open a node's document. */
	onOpenNode?: (nodeId: string, title: string) => void;
	/** Choose a .rrnode and upload it as a version. */
	onUpload?: () => void;
	/** Why the last upload failed. */
	error?: string;
}

/** The upload row's id: no node id has a leading '+'. */
const UPLOAD = '+upload';

/**
 * The Nodes tool's sidebar body: the Introduction, then the nodes you
 * publish (upload one, open one to publish its versions).
 */
export const NodesSidebarPanel: React.FC<INodesSidebarPanelProps> = ({ onShowIntro, nodes = [], activeNodeId, onOpenNode, onUpload, error }) => {
	const navMenu: ViewMenu = {
		entries: [{ id: 'intro', label: 'Introduction to Nodes', icon: <BxNote size={16} /> }],
	};
	return (
		<div style={panelStyles.panelColumn}>
			{onShowIntro && (
				<div style={panelStyles.navSection}>
					<SidebarMenu
						menu={navMenu}
						activeId=""
						onSelect={(id) => {
							if (id === 'intro') onShowIntro('nodes');
						}}
					/>
				</div>
			)}
			{onOpenNode ? (
				<div style={panelStyles.navSection}>
					<SidebarMenu
						menu={{
							entries: [...(onUpload ? [{ id: UPLOAD, label: 'Upload a node…', icon: <CodiconCircuitBoard size={16} /> }] : []), ...nodes.map((n) => ({ id: n.id, label: n.title === n.id ? n.id : `${n.title} (${n.id})`, icon: <CodiconCircuitBoard size={16} /> }))],
						}}
						activeId={activeNodeId ?? ''}
						onSelect={(id) => {
							if (id === UPLOAD) onUpload?.();
							else onOpenNode(id, nodes.find((n) => n.id === id)?.title ?? id);
						}}
					/>
					{error ? <div style={{ ...panelStyles.comingSoon, color: 'var(--rr-color-error)' }}>{error}</div> : null}
					{nodes.length === 0 ? <div style={panelStyles.comingSoon}>No published node reaches you yet. Upload a .rrnode, then publish it to @me.</div> : null}
				</div>
			) : (
				<div style={panelStyles.comingSoon}>Coming soon...</div>
			)}
		</div>
	);
};

export default NodesSidebarPanel;
