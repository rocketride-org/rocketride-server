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
// MONITOR SIDEBAR — the page menu that replaced the top tab strip
// =============================================================================
//
// One SidebarMenu over the monitor's four pages (Overview / Connections /
// Tasks / Activity), with the same count badges the old TabControl strip
// carried. Badge counts come from the shared useDashboardData singleton —
// in-app that is the very poll MonitorSurface already runs (no extra
// traffic); as a devToolSidebar the mount document has its own connection
// and runs its own poll.
//
// Two mounts, one menu:
//  - In-app: MonitorApp owns the page state and passes it straight in.
//  - devToolSidebar: the menu lives in the HOST's sidebar, an isolated
//    document — selections ride the DevToolProps peer channel to the frame.

import React, { useEffect, useMemo, useState } from 'react';
import { SidebarMenu, useDashboardData } from 'shell';
import type { DevToolProps, MonitorPageId, ViewMenu } from 'shell';

// =============================================================================
// PEER PROTOCOL — sidebar mount ↔ frame (app-internal)
// =============================================================================

/**
 * The page-sync wire protocol between the tool's two mounts. Either
 * direction: "the active page is / should be `page`". The FRAME pushes it on
 * mount and on every change (the host retains the last push for a reloaded
 * sidebar); the SIDEBAR posts it only on a user selection.
 */
export type MonitorPeerMessage = { op: 'page'; page: MonitorPageId };

// =============================================================================
// COMPONENT — the menu itself
// =============================================================================

/** Props for {@link MonitorSidebar}. */
export interface IMonitorSidebarProps {
	/** The active page id (drawn as the list highlight). */
	activeId: MonitorPageId;
	/** Fired with a page id when the user selects it. */
	onSelect: (id: MonitorPageId) => void;
}

/**
 * The monitor's page menu: four rows with live count badges, rendered with
 * the stock SidebarMenu (collapse-aware in the shell frame; plain list as a
 * devToolSidebar).
 *
 * @param props - {@link IMonitorSidebarProps}.
 */
export const MonitorSidebar: React.FC<IMonitorSidebarProps> = ({ activeId, onSelect }) => {
	// Shared 3s dashboard snapshot — the badge source. In-app this is the
	// same singleton MonitorSurface polls; a devToolSidebar document polls
	// through its own host-connected client.
	const { data, events } = useDashboardData();

	// Same entries + counts the old TabControl strip declared.
	const menu = useMemo<ViewMenu>(
		() => ({
			entries: [
				{ id: 'overview', label: 'Overview' },
				{ id: 'connections', label: 'Connections', ...(data ? { count: data.overview.totalConnections } : {}) },
				{ id: 'tasks', label: 'Tasks', ...(data ? { count: data.overview.activeTasks } : {}) },
				{ id: 'activity', label: 'Activity', ...(events.length > 0 ? { count: events.length } : {}) },
			],
		}),
		[data, events.length]
	);

	return <SidebarMenu menu={menu} activeId={activeId} onSelect={(id) => onSelect(id as MonitorPageId)} />;
};

// =============================================================================
// DEV-TOOL SIDEBAR — the menu in the host's sidebar, synced over peer
// =============================================================================

/**
 * The page menu as a host-mounted devToolSidebar: selections post over the
 * peer channel to the frame panel, and the frame's current page arrives back
 * the same way (seeded by a `hello` on mount, since the frame may already be
 * on a page when this mount attaches).
 */
export const MonitorDevToolSidebar: React.FC<DevToolProps> = ({ peer }) => {
	const [page, setPage] = useState<MonitorPageId>('overview');

	// The frame pushes its page on mount and on change (the host retains the
	// last push across sidebar reloads) — this mount only listens, and posts
	// nothing except user selections below.
	useEffect(
		() =>
			peer.subscribe((message) => {
				const msg = message as MonitorPeerMessage;
				if (msg && msg.op === 'page') setPage(msg.page);
			}),
		[peer]
	);

	return (
		<MonitorSidebar
			activeId={page}
			onSelect={(id) => {
				setPage(id);
				peer.post({ op: 'page', page: id } satisfies MonitorPeerMessage);
			}}
		/>
	);
};

export default MonitorSidebar;
