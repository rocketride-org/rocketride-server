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
// APP DESCRIPTOR — rocket-ui MF remote entry point
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell';
import RocketApp from './RocketApp';
// SVGR turns these imports into React components (see assets.d.ts), so they
// are rendered directly rather than used as <img> URLs.
import IconDark from 'shared/assets/rocketride/rocketride-dark.svg';
import IconLight from 'shared/assets/rocketride/rocketride-light.svg';

/**
 * AppDescriptor for the RocketRide pipeline editor app.
 *
 * Uses the Documents library for multi-document, multi-editor-group support.
 */
const ROCKETRIDE_APP: AppDescriptor = {
	id: 'rocketride.pipeBuilder',
	name: 'Pipeline Builder',
	branding: {
		appName: 'Pipeline Builder',
		iconDark: React.createElement(IconDark, { style: { width: '100%', height: '100%' } }),
		iconLight: React.createElement(IconLight, { style: { width: '100%', height: '100%' } }),
		welcomeTitle: 'Pipeline Builder',
		welcomeSubtitle: 'Open a project from the Explorer or create a new one to get started.',
	},
	// Two-column app: RocketApp's root AppLayout declares the pipelines
	// Explorer sidebar and the status bar.
	app: RocketApp,
};

export default ROCKETRIDE_APP;
