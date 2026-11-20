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

// HMR anchor: keeps the shared jsx runtime referenced even when the app's
// root component fails to compile — an error build otherwise orphans it, the
// hot runtime tombstones its factory, and every later fix-apply dies
// silently (the frozen-preview bug).
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import HelloApp from './HelloApp';

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
		// NO iconDark/iconLight here: branding icons OUTRANK the manifest icon
		// by contract, and the RocketRideMark entries this block used to carry
		// (wordmark-header era) masked the app's real icon on the rail and
		// panel header. Absent, the shell falls through to the manifest icon.
	},
	// Frame-only app: HelloApp's root AppLayout keeps the branded sidebar
	// frame (empty slot) and the status bar.
	app: HelloApp,
};

export default HELLO_APP;
