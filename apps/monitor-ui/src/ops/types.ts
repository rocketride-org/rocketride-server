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
// pattern). What remains here is COORDINATION of shared state, never
// transport: the controller (the tool's sidebar mount) runs the ONE dashboard
// poller shared by all views and publishes each tick as the retained
// 'dashboard' topic; `monitor.refresh` nudges that poller. The grids page
// with the frame's own realm client — those ops are gone.
// =============================================================================

import type { ToolOpMap, ToolOpSpec, ToolStateMap, ToolEventMap } from 'shell';
import type { ActivityEvent, DashboardResponse, MonitorPageId } from '../monitor';

/** The 'dashboard' topic's snapshot shape. */
export interface IDashboardSnapshot {
	/** Latest dashboard response (null until the first poll lands). */
	data: DashboardResponse | null;
	/** Activity events, newest first. */
	events: ActivityEvent[];
}

/** The monitor's op map — private to this tool. */
export interface MonitorOps extends ToolOpMap {
	/** Manual dashboard refresh — nudges the controller's shared poller. */
	'monitor.refresh': ToolOpSpec<Record<string, never>, void>;
}

/** The monitor's events (either direction). */
export interface MonitorEventMap extends ToolEventMap {
	/** Page sync: "the active page is / should be `page`". The FRAME pushes
	 *  it on mount and on every change (the host retains the last frame push
	 *  for a reloaded sidebar); the SIDEBAR sends it only on a user
	 *  selection. */
	page: MonitorPageId;
}

/** The monitor's state topics (controller → documents). */
export interface MonitorStateMap extends ToolStateMap {
	/** The controller's dashboard snapshot + activity feed, every poll tick. */
	dashboard: IDashboardSnapshot;
}
