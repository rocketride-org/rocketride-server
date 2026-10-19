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
// MONITOR PROTOCOL — frames ask, the controller executes
// =============================================================================
//
// The tool's wire vocabulary as protocol maps (shell ToolOpMap/ToolStateMap
// pattern). The dev-tool frame holds NO RocketRide client. The controller
// (the tool's sidebar mount) polls the dashboard with its own connection and
// publishes the snapshot + activity feed as the retained 'dashboard' topic;
// the frame's two remote grids page through correlated ops. Connection
// reachability rides the shell's `host:connection` system topic.
// =============================================================================

import type { ToolOpMap, ToolOpSpec, ToolStateMap } from 'shell';
import type { ActivityEvent, DashboardConnection, DashboardResponse, DashboardTask, ListPageRequest, ListPageResponse } from 'shell';

/** The 'dashboard' topic's snapshot shape. */
export interface IDashboardSnapshot {
	/** Latest dashboard response (null until the first poll lands). */
	data: DashboardResponse | null;
	/** Activity events, newest first. */
	events: ActivityEvent[];
}

/** The monitor's op map — private to this tool. */
export interface MonitorOps extends ToolOpMap {
	/** One page of the Connections grid (REMOTE mode paging/sort/filter). */
	'monitor.listConnections': ToolOpSpec<ListPageRequest, ListPageResponse<DashboardConnection>>;
	/** One page of the Tasks grid. */
	'monitor.listTasks': ToolOpSpec<ListPageRequest, ListPageResponse<DashboardTask>>;
	/** Manual dashboard refresh (the view's refresh affordance). */
	'monitor.refresh': ToolOpSpec<Record<string, never>, void>;
}

/** The monitor's state topics (controller → documents). */
export interface MonitorStateMap extends ToolStateMap {
	/** The controller's dashboard snapshot + activity feed, every poll tick. */
	dashboard: IDashboardSnapshot;
}
