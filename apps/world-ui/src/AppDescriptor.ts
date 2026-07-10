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
import type { AppDescriptor } from 'shell-ui';
import HelloApp from './HelloApp';
import HelloSidebar from './HelloSidebar';
import RocketRideMark from './RocketRideMark';

/**
 * AppDescriptor for the Hello World demo app.
 *
 * A minimal app with an empty sidebar. Does not require authentication.
 */
const HELLO_APP: AppDescriptor = {
	id: 'rocketride.helloWorld',
	name: 'Hello World',
	branding: {
		appName: 'Hello World',
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0' }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34' }),
	},
	components: {
		App: HelloApp,
		Sidebar: HelloSidebar,
	},
};

export default HELLO_APP;
