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
// APP DESCRIPTOR — aparavi-ui MF remote entry point (Aparavi AQL Chat)
// =============================================================================

// HMR anchor: keeps the shared jsx runtime referenced even when the app's
// root component fails to compile — an error build otherwise orphans it, the
// hot runtime tombstones its factory, and every later fix-apply dies
// silently (the frozen-preview bug).
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import AparaviApp from './AparaviApp';

/**
 * AppDescriptor for the Aparavi AQL Chat application.
 *
 * Chat interface for querying Aparavi data via natural language.
 * Multi-tab support via Documents library — each tab is an independent chat.
 * Requires authentication (authenticated: true in manifest).
 */
const APARAVI_APP: AppDescriptor = {
	id: 'rocketride.aparavi',
	name: 'Aparavi AQL',
	branding: {
		appName: 'Aparavi AQL',
	},
	// Two-column app: AparaviApp's root AppLayout declares the chat-file
	// Explorer sidebar and the status bar.
	app: AparaviApp,
};

export default APARAVI_APP;
