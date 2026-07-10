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
// PROFILER-UI — App Descriptor
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell-ui';
import ProfilerApp from './ProfilerApp';
import ProfilerSidebar from './ProfilerSidebar';
import RocketRideMark from './RocketRideMark';

/**
 * AppDescriptor for the Profiler app.
 *
 * Provides cProfile-based process profiling: start/stop sessions on the
 * server process or pipeline engine subprocesses, view function-level
 * pstats reports, and manage connections.
 */
const PROFILER_APP: AppDescriptor = {
	id: 'rocketride.profiler',
	name: 'Profiler',
	branding: {
		appName: 'Profiler',
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0' }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34' }),
	},
	components: {
		App: ProfilerApp,
		Sidebar: ProfilerSidebar,
	},
};

export default PROFILER_APP;
