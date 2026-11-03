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

// HMR anchor: keeps the shared jsx runtime referenced even when the app's
// root component fails to compile — an error build otherwise orphans it, the
// hot runtime tombstones its factory, and every later fix-apply dies
// silently (the frozen-preview bug).
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import ProfilerApp, { ProfilerDevTool } from './ProfilerApp';
import { ProfilerDevToolSidebar } from './ProfilerSidebar';

/**
 * AppDescriptor for the Profiler app.
 *
 * Provides cProfile-based process profiling against the host's connected
 * engine: start/stop sessions on the server process or pipeline engine
 * subprocesses and view function-level pstats reports. All controls live in
 * the sidebar panel.
 */
const PROFILER_APP: AppDescriptor = {
	id: 'rocketride.profiler',
	name: 'Profiler',
	branding: {
		appName: 'Profiler',
		// NO iconDark/iconLight here: branding icons OUTRANK the manifest icon
		// by contract, and the RocketRideMark entries this block used to carry
		// (wordmark-header era) masked the app's real icon on the rail and
		// panel header. Absent, the shell falls through to the manifest icon.
	},
	// The full app: the profiler frame with the control panel in the sidebar
	// and the status bar.
	app: ProfilerApp,
	// Dev-tool mounts: the bare frame in the host's main area, the control
	// panel in the host's sidebar — state and actions sync over the peer
	// channel.
	devToolFrame: ProfilerDevTool,
	devToolSidebar: ProfilerDevToolSidebar,
};

export default PROFILER_APP;
