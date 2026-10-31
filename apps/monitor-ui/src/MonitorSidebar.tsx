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
//    document — selections ride the tool channel ('page' event) to the frame.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SidebarMenu, typedToolChannel, useShellEvent } from 'shell';
import { useDashboardData } from './monitor/useDashboardData';
import type { DevToolProps, ViewMenu } from 'shell';
import type { MonitorPageId } from './monitor';
import { serveMonitorOps } from './ops';
import type { IDashboardSnapshot, MonitorEventMap, MonitorStateMap } from './ops';

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
// DEV-TOOL SIDEBAR — the menu in the host's sidebar, synced over the channel
// =============================================================================

/**
 * The page menu as a host-mounted devToolSidebar: selections ride the
 * channel's 'page' event to the frame panel, and the frame's current page
 * arrives back the same way (the host retains the frame's last push, so a
 * remounted sidebar renders without asking).
 */
export const MonitorDevToolSidebar: React.FC<DevToolProps> = ({ channel, documents }) => {
	const [page, setPage] = useState<MonitorPageId>('overview');

	// SINGLE-PANE UX: the monitor is one surface, so activating its sidebar
	// tab opens (or reveals) the pane — the tool's choice, made here.
	//
	// Mounting is NOT an activation. The host keeps every pinned tool's
	// sidebar mounted (SidebarChrome's TabPanel hides inactive panels with
	// display:none rather than unmounting them), so opening on mount
	// reopened this pane on every page load — including panes the user had
	// deliberately closed. This listener is registered long before any
	// selection can happen, so it covers the first selection too.
	useShellEvent('shell:toolSidebarActivated', ({ appId }) => {
		if (appId === 'rocketride.monitor') documents?.open('', 'Server Monitor');
	});

	const toolChannel = useMemo(() => typedToolChannel<MonitorStateMap, MonitorEventMap>(channel), [channel]);

	// The frame pushes its page on mount and on change (the host retains the
	// last push across sidebar reloads) — this mount only listens, and sends
	// nothing except user selections below.
	useEffect(() => toolChannel.onEvent('page', setPage), [toolChannel]);

	// This mount's own dashboard poll (the badge source below shares the same
	// module singleton) doubles as the frame's data feed: publish every tick
	// as retained state so a frame opening later renders immediately.
	const { data, events, refresh } = useDashboardData();
	useEffect(() => {
		toolChannel.publishState('dashboard', { data, events } satisfies IDashboardSnapshot);
	}, [toolChannel, data, events]);

	// The frame's manual refresh, nudging this mount's shared poller. The
	// grids page with the frame's own realm client — nothing served for them.
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useEffect(() => serveMonitorOps(channel, { refresh: () => refreshRef.current() }), [channel]);

	return (
		<MonitorSidebar
			activeId={page}
			onSelect={(id) => {
				setPage(id);
				toolChannel.sendEvent('page', id);
			}}
		/>
	);
};

export default MonitorSidebar;
