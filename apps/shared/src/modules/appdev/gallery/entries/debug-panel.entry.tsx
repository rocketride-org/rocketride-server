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
// DEBUG PANEL — GALLERY ENTRY (HOST CHROME)
// =============================================================================

/** Gallery entry for the ALT+D DebugPanel event trace. */

import React from 'react';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';
import { FrameSchematic } from './demos/FrameSchematic';

/** Schematic demo: the right-docked debug panel. */
const DebugPanelDemo: React.FC<IGalleryDemoProps> = () => <FrameSchematic highlight="debugPanel" />;

/** The DebugPanel gallery entry. */
export const debugPanelEntry: IGalleryEntry = {
	id: 'debug-panel',
	name: 'Debug panel',
	group: 'chrome',
	blurb: 'The right-docked (360px) ALT+D event trace: a live scrolling log of every shell event and iframe postMessage, with a name filter and a Clear button.',
	doc: `Press **ALT+D** anywhere in the shell to toggle it. The panel passively listens to the \`ConnectionManager\` wildcard handler and to window \`message\` traffic, so every \`shell:*\` event an app emits or consumes shows up here with its payload — the first tool to reach for when an event does not arrive.

Auto-scroll locks to the bottom until you scroll up; the text filter narrows by event name.`,
	docNote: 'Apps never mount DebugPanel - the shell owns the ALT+D toggle. Use it to VERIFY your app\'s shell:* event traffic during development.',
	demo: DebugPanelDemo,
	code: `// Nothing to mount - press ALT+D in the shell to toggle the trace.
// Every ConnectionManager event an app emits is visible there:
import { ConnectionManager } from 'shell';

ConnectionManager.getInstance().emit('shell:openOverlay', { id: 'settings' });
// ... shows up in the DebugPanel log with its payload.`,
	props: [
		{ name: 'onClose', type: '() => void', dir: 'out', required: true, note: 'Fired by the panel close button; the shell hides the panel (same as ALT+D).' },
	],
};
