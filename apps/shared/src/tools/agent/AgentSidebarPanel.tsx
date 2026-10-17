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
// TOOLS/AGENT — the Agent tool's SIDEBAR PANEL (MY SESSIONS)
// =============================================================================
//
// Extracted from the fixed-mode SidebarView monolith (Phase 5): the + New
// session nav and the MY SESSIONS list. The chat/session machinery stays in
// the agent domain module (apps/shared/src/agent) — this is the tool
// interface over it.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { BxNote, BxPlus, BxTrash } from 'shell';
import { SidebarMenu } from 'shell';
import type { ViewMenu } from 'shell';
import { PANEL_HOVER_BG, panelStyles } from '../core/chrome/panelStyles';
import type { AgentSidebar } from '../../modules/sidebar/types';
import type { IntroMode } from '../../modules/intro/introPages';

/**
 * Formats a session stamp for the MY SESSIONS meta line: minutes/hours for
 * today ("12m ago", "3h ago"), "yesterday", then a short month-day ("Sep 24").
 *
 * @param date - Epoch-ms creation stamp.
 * @returns The human-relative label.
 */
function formatSessionDate(date: number): string {
	const elapsed = Date.now() - date;
	if (elapsed < 3_600_000) return `${Math.max(1, Math.round(elapsed / 60_000))}m ago`;
	if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
	if (elapsed < 2 * 86_400_000) return 'yesterday';
	return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Props for {@link AgentSidebarPanel}. */
export interface IAgentSidebarPanelProps {
	/** The MY SESSIONS list + its actions (the tool controller's state). */
	agent: AgentSidebar;
	/** Open the embedded Introduction page. */
	onShowIntro?: (mode: IntroMode) => void;
}

/**
 * The Agent tool's sidebar body: nav + the MY SESSIONS list.
 */
export const AgentSidebarPanel: React.FC<IAgentSidebarPanelProps> = ({ agent, onShowIntro }) => {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: PANEL_HOVER_BG } : {});

	// "+ New session" with the embedded Introduction row above it.
	const navMenu: ViewMenu = {
		entries: [...(onShowIntro ? [{ id: 'intro', label: 'Introduction to Agents', icon: <BxNote size={16} /> }] : []), { id: 'newSession', label: 'New session', icon: <BxPlus size={16} /> }],
	};

	return (
		<div style={panelStyles.panelColumn}>
			<div style={panelStyles.navSection}>
				<SidebarMenu
					menu={navMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'newSession') agent.onNewSession();
						if (id === 'intro') onShowIntro?.('agent');
					}}
				/>
			</div>
			<div style={panelStyles.sectionLabel}>My Sessions</div>
			<div style={panelStyles.sectionList}>
				{agent.sessions.length === 0 && (
					<div style={panelStyles.emptyLine}>No sessions yet — start one with New session.</div>
				)}
				{agent.sessions.map((session) => {
					const rowKey = `sess:${session.sessionId}`;
					const active = session.sessionId === agent.activeSessionId;
					return (
						<div
							key={session.sessionId}
							role="button"
							tabIndex={0}
							style={{ ...panelStyles.row, alignItems: 'flex-start', ...(active ? { background: PANEL_HOVER_BG } : hoverBg(rowKey)) }}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							// step: keyboard parity — focus marks the row (the hover-gated
							// delete button needs a reachable target), Enter/Space opens it
							onFocus={() => setHoveredRow(rowKey)}
							onBlur={(e) => {
								if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoveredRow((prev) => (prev === rowKey ? null : prev));
							}}
							onKeyDown={(e) => {
								// only the ROW itself — the nested delete button's
								// Enter/Space bubbles here and must keep deleting
								if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
								e.preventDefault();
								agent.onOpenSession(session.sessionId);
							}}
							onClick={() => agent.onOpenSession(session.sessionId)}
							title={session.title}
						>
							{/* Two-line row: title over the relative date; the 14px
							    chevron slot keeps alignment with the other modes. */}
							<span style={{ width: 14, flexShrink: 0 }} />
							<div style={{ flex: 1, minWidth: 0, padding: '2px 0' }}>
								<div style={panelStyles.rowName}>{session.title}</div>
								<div style={{ fontSize: 11, lineHeight: '14px', color: 'var(--rr-text-secondary)' }}>{formatSessionDate(session.date)}</div>
							</div>
							{hoveredRow === rowKey && (
								<button
									style={panelStyles.actionBtn('var(--rr-text-secondary)')}
									title="Delete session"
									onClick={(e) => {
										e.stopPropagation();
										agent.onDeleteSession(session.sessionId);
									}}
								>
									<BxTrash size={14} />
								</button>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
};

export default AgentSidebarPanel;
