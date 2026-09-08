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
// EVENTS-UI — APP DESCRIPTOR
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell';
import { RocketRideMark } from 'shell';
import EventsApp from './EventsApp';

/**
 * Event Monitor app descriptor. EventsApp's root AppLayout keeps the shell's
 * branded Header/Footer sidebar frame present (empty middle); the app's run
 * controls live in the Capture card, not the sidebar.
 */
const EVENTS_APP: AppDescriptor = {
	id: 'rocketride.events',
	name: 'Event Monitor',
	branding: {
		appName: 'Event Monitor',
		// style fills the shell's sized icon wrapper (the shared mark defaults to a
		// fixed 24px; width/height:100% preserves the prior fill-to-slot behaviour).
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0', style: { width: '100%', height: '100%' } }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34', style: { width: '100%', height: '100%' } }),
	},
	// Frame-only app: EventsApp's root AppLayout keeps the branded sidebar
	// frame (empty slot) and the status bar.
	app: EventsApp,
};

export default EVENTS_APP;
