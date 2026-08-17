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
// APP DESCRIPTOR — hello-ui MF remote entry point
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell';
import HelloApp from './HelloApp';
import { RocketRideMark } from 'shell';

/**
 * AppDescriptor for the Hello World demo app.
 *
 * A minimal app. Does not require authentication.
 */
const HELLO_APP: AppDescriptor = {
	// Must match world.rrapp + package.json appManifest.id (workspace types contract).
	id: 'rocketride.world',
	name: 'Hello World',
	branding: {
		appName: 'Hello World',
		// style fills the shell's sized icon wrapper (the shared mark defaults to a
		// fixed 24px; width/height:100% preserves the prior fill-to-slot behaviour).
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0', style: { width: '100%', height: '100%' } }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34', style: { width: '100%', height: '100%' } }),
	},
	// Frame-only app: HelloApp's root AppLayout keeps the branded sidebar
	// frame (empty slot) and the status bar.
	app: HelloApp,
};

export default HELLO_APP;
