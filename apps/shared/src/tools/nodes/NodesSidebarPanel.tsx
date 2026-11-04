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
import { SidebarMenu } from 'shell';
import type { ViewMenu } from 'shell';
import { panelStyles } from '../core/chrome/panelStyles';
import type { IntroMode } from '../introCatalog';

/** Props for {@link NodesSidebarPanel}. */
export interface INodesSidebarPanelProps {
	/** Open the embedded Introduction page. */
	onShowIntro?: (mode: IntroMode) => void;
}

/**
 * The Node Builder tool's sidebar body — the Introduction row above the
 * placeholder, until the node builder lands.
 */
export const NodesSidebarPanel: React.FC<INodesSidebarPanelProps> = ({ onShowIntro }) => {
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
			<div style={panelStyles.comingSoon}>Coming soon...</div>
		</div>
	);
};

export default NodesSidebarPanel;
