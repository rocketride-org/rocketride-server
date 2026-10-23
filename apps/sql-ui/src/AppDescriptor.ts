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
// SQL-UI — APP DESCRIPTOR
// =============================================================================

// HMR anchor: keeps the shared jsx runtime referenced even when the app's
// root component fails to compile — an error build otherwise orphans it, the
// hot runtime tombstones its factory, and every later fix-apply dies
// silently (the frozen-preview bug).
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import SqlApp from './SqlApp';
import SqlDevTool from './SqlDevTool';
import { SqlDevToolSidebar } from './SqlSidebar';
import { SQL_APP_ID } from './appId';

/**
 * SQL Explorer app descriptor. The client area hosts the connection landing
 * view and (in later phases) the per-connection workbench documents; the
 * sidebar carries the app navigation and, once a connection is open, the
 * schema tree.
 */
const SQL_APP: AppDescriptor = {
	id: SQL_APP_ID,
	name: 'SQL Explorer',
	branding: {
		appName: 'SQL Explorer',
		// NO iconDark/iconLight here: branding icons OUTRANK the manifest icon
		// by contract, and the RocketRideMark entries this block used to carry
		// (wordmark-header era) masked the app's real icon on the rail and
		// panel header. Absent, the shell falls through to the manifest icon.
	},
	// Two-column app: SqlApp's root AppLayout declares the navigation/schema
	// sidebar and the status bar.
	app: SqlApp,
	// Dev-tool mounts: the workbench in the host's main area, the
	// connections/schema sidebar in the host's sidebar — actions and state
	// sync over the peer channel (sqlBridge).
	devToolFrame: SqlDevTool,
	devToolSidebar: SqlDevToolSidebar,
};

export default SQL_APP;
