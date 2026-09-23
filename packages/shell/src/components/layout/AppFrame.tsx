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
// APP FRAME — the framing control that mounts the active app
// =============================================================================
//
// One contract: the descriptor's `app` component is mounted raw in the client
// area. The app composes its own layout inside with <AppLayout> (one column,
// sidebar, status bar — all declared as props from the app's one tree).
//
// This component is deliberately the SEAM for the coming frame isolation:
// when apps move into their own iframes, the swap happens here — the app
// contract and AppLayout stay unchanged.
// =============================================================================

import React from 'react';
import type { ConnectResult } from 'rocketride';
import type { AppDescriptor } from '../workspace/types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link AppFrame}. */
export interface AppFrameProps {
	/** The loaded descriptor of the app to mount. */
	app: AppDescriptor;
	/** Whether the RocketRide WebSocket is currently connected. */
	isConnected: boolean;
	/** Authenticated user identity, or null when not logged in. */
	identity: ConnectResult | null;
}

// =============================================================================
// APP FRAME
// =============================================================================

/**
 * Mounts the app's `app` component raw in the client area.
 *
 * @param props - See {@link AppFrameProps}.
 */
export const AppFrame: React.FC<AppFrameProps> = ({ app, isConnected, identity }) => {
	const App = app.app;
	if (!App) return null;
	return <App isConnected={isConnected} identity={identity} />;
};
