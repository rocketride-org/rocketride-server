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
// STATUS BAR — GALLERY ENTRY (DOC-ONLY, HOST CHROME)
// =============================================================================

/** Gallery entry for the shell-owned StatusBar. */

import React from 'react';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';
import { FrameSchematic } from './demos/FrameSchematic';

/** Schematic demo: the status bar at the bottom of the frame. */
const StatusBarDemo: React.FC<IGalleryDemoProps> = () => <FrameSchematic highlight="statusBar" />;

/** The StatusBar gallery entry. */
export const statusBarEntry: IGalleryEntry = {
	id: 'status-bar',
	name: 'StatusBar',
	group: 'chrome',
	blurb: 'The bottom bar with the GLOBAL connection status: app name on the left, connection dot + label when authenticated, Ready / Offline on the right.',
	doc: `There is ONE connection state for the whole shell — never per-app or per-tab — and the StatusBar is its single visual home. An app REACTS to the same global state via \`useShellConnection()\` (e.g. disabling actions while offline) instead of inventing a second status UI.

In VS Code the equivalent is a native status-bar contribution outside the webview.`,
	docNote: 'Never mount the StatusBar and never build a per-app status strip. Per-item state belongs in the view as a StatusBadge; view-level messages are a Banner.',
	demo: StatusBarDemo,
	code: `// Apps never render the StatusBar - the shell wires it from the global
// connection state. An app REACTS to the same state via the shell hook:
import { useShellConnection } from 'shell';
import { Button } from 'shell';

function RunControls() {
	const { isConnected } = useShellConnection();
	// Disable actions while offline instead of inventing a second status UI.
	return <Button disabled={!isConnected} onClick={runPipeline}>Run</Button>;
}`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'useShellConnection', type: '() => { client, isConnected, statusMessage }', dir: 'out', note: 'The same global state the StatusBar renders - subscribe to react to connect/disconnect and transient status messages.' },
	],
};
