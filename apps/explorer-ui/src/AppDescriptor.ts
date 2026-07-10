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
// APP DESCRIPTOR — explorer-ui MF remote entry point (File Explorer)
// =============================================================================

import type { AppDescriptor } from 'shell-ui';
import ExplorerApp from './ExplorerApp';
import ExplorerSidebar from './ExplorerSidebar';

/**
 * AppDescriptor for the File Explorer application.
 *
 * Browse, view, and edit files stored on the RocketRide server.
 * Multi-tab + split-pane support via Documents library.
 * Sidebar with file tree; status bar enabled in manifest.
 * Requires authentication (authenticated: true in manifest).
 */
const EXPLORER_APP: AppDescriptor = {
	id: 'rocketride.explorer',
	name: 'File Explorer',
	branding: {
		appName: 'File Explorer',
	},
	components: {
		App: ExplorerApp,
		Sidebar: ExplorerSidebar,
	},
};

export default EXPLORER_APP;
