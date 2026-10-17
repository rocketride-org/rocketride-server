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
// TOOLS/APPDEV — the App Builder tool's SIDEBAR PANEL (MY APPS)
// =============================================================================
//
// Extracted from the fixed-mode SidebarView monolith (Phase 5): the + New
// app nav (with Desktop / Introduction rows where the host wires them) and
// the MY APPS list the tool's discovery loop feeds.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { BxDesktop, BxGridAlt, BxNote, BxPlus } from 'shell';
import { SidebarMenu } from 'shell';
import type { ViewMenu } from 'shell';
import { PANEL_HOVER_BG, panelStyles } from '../core/chrome/panelStyles';
import type { AppBuilderSidebar } from '../../modules/sidebar/types';
import type { IntroMode } from '../../modules/intro/introPages';

/** Props for {@link AppDevSidebarPanel}. */
export interface IAppDevSidebarPanelProps {
	/** The MY APPS list + its actions (the tool controller's state). */
	appBuilder: AppBuilderSidebar;
	/** Open the embedded Introduction page. */
	onShowIntro?: (mode: IntroMode) => void;
	/** Open the shared Desktop page (hosts that have one). */
	onShowDesktop?: () => void;
}

/**
 * The App Builder tool's sidebar body: nav + the MY APPS list.
 */
export const AppDevSidebarPanel: React.FC<IAppDevSidebarPanelProps> = ({ appBuilder, onShowIntro, onShowDesktop }) => {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: PANEL_HOVER_BG } : {});

	// "+ New app" with the optional Desktop / Introduction rows above it.
	const navMenu: ViewMenu = {
		entries: [...(onShowDesktop ? [{ id: 'desktop', label: 'Desktop', icon: <BxDesktop size={16} /> }] : []), ...(onShowIntro ? [{ id: 'intro', label: 'Introduction to Apps', icon: <BxNote size={16} /> }] : []), { id: 'newApp', label: 'New app', icon: <BxPlus size={16} /> }],
	};

	return (
		<div style={panelStyles.panelColumn}>
			<div style={panelStyles.navSection}>
				<SidebarMenu
					menu={navMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'newApp') appBuilder.onNewApp();
						if (id === 'intro') onShowIntro?.('apps');
						if (id === 'desktop') onShowDesktop?.();
					}}
				/>
			</div>
			<div style={panelStyles.sectionLabel}>My Apps</div>
			<div style={panelStyles.sectionList}>
				{appBuilder.apps.length === 0 && (
					<div style={panelStyles.emptyLine}>No apps yet. Create one with New app.</div>
				)}
				{appBuilder.apps.map((app) => {
					const rowKey = `app:${app.id}`;
					const active = app.id === appBuilder.activeAppId;
					return (
						<div
							key={app.id}
							style={{ ...panelStyles.row, ...(active ? { background: PANEL_HOVER_BG } : hoverBg(rowKey)) }}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => appBuilder.onOpenApp(app.id)}
							title={app.folder ? `${app.id}\n${app.folder}` : app.id}
						>
							{/* Mirror the Explorer file-row anatomy — 14px chevron slot
							    (apps don't expand) + 16px leading icon — so app icons and
							    names align column-for-column with the pipeline rows. */}
							<span style={{ width: 14, flexShrink: 0 }} />
							{app.iconUrl ? (
								<img src={app.iconUrl} alt="" style={panelStyles.rowIcon} />
							) : (
								<BxGridAlt size={16} color="var(--rr-text-secondary)" />
							)}
							<span style={panelStyles.rowName}>{app.name}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
};

export default AppDevSidebarPanel;
