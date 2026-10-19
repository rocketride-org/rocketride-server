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
// MONITOR-UI — App Descriptor
// =============================================================================

// HMR anchor: keeps the shared jsx runtime referenced even when the app's
// root component fails to compile — an error build otherwise orphans it, the
// hot runtime tombstones its factory, and every later fix-apply dies
// silently (the frozen-preview bug).
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import MonitorApp, { MonitorDevToolFrame } from './MonitorApp';
import { MonitorDevToolSidebar } from './MonitorSidebar';

/**
 * AppDescriptor for the Server Monitor app.
 *
 * Provides a real-time dashboard showing server connections, tasks,
 * resource usage, and activity events.
 */
const MONITOR_APP: AppDescriptor = {
	id: 'rocketride.monitor',
	name: 'Server Monitor',
	branding: {
		appName: 'Server Monitor',
		// NO iconDark/iconLight here: branding icons OUTRANK the manifest icon
		// by contract, and the RocketRideMark entries this block used to carry
		// (wordmark-header era) masked the app's real icon on the rail and
		// panel header. Absent, the shell falls through to the manifest icon.
	},
	// The full app: the monitor surface with the page menu in the sidebar
	// (the old top tab strip is gone) and the status bar.
	app: MonitorApp,
	// Dev-tool mounts: the bare monitor surface in the host's main area, the
	// page menu in the host's sidebar — page selection syncs over the peer
	// channel. Each mount runs against its own connected shell singleton.
	devToolFrame: MonitorDevToolFrame,
	devToolSidebar: MonitorDevToolSidebar,
};

export default MONITOR_APP;
