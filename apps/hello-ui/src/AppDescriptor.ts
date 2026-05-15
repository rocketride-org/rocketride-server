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
// APP DESCRIPTOR — hello-ui MF remote entry point (OSS landing page)
// =============================================================================

import type { AppDescriptor } from 'shell-ui';
import HomeApp from './HomeApp';

/**
 * AppDescriptor for the OSS landing page.
 *
 * Shows installed apps as a simple grid. No app store, no subscriptions.
 * Runs without authentication (authenticated: false in manifest).
 * No Sidebar — the shell hides the sidebar zone for full-screen rendering.
 */
const HOME_APP: AppDescriptor = {
	id: 'rocketride.hello',
	name: 'RocketRide',
	branding: {
		appName: 'RocketRide',
	},
	components: {
		App: HomeApp,
		// No Sidebar — full-screen app
	},
};

export default HOME_APP;
