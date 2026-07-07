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

import React from 'react';
import type { AppDescriptor } from 'shell-ui';
import MonitorApp from './MonitorApp';
import MonitorSidebar from './MonitorSidebar';
import RocketRideMark from './RocketRideMark';

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
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0' }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34' }),
	},
	components: {
		App: MonitorApp,
		Sidebar: MonitorSidebar,
	},
};

export default MONITOR_APP;
