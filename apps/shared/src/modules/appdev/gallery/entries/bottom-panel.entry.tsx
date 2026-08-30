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
// BOTTOM PANEL — GALLERY ENTRY (HOST CHROME)
// =============================================================================

/** Gallery entry for the BottomPanel output panel. */

import React from 'react';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';
import { FrameSchematic } from './demos/FrameSchematic';

/** Schematic demo: the bottom panel zone above the StatusBar. */
const BottomPanelDemo: React.FC<IGalleryDemoProps> = () => <FrameSchematic highlight="bottomPanel" />;

/** The BottomPanel gallery entry. */
export const bottomPanelEntry: IGalleryEntry = {
	id: 'bottom-panel',
	name: 'Bottom panel',
	group: 'chrome',
	blurb: 'The fixed-height (140px) output panel above the StatusBar: a tab row (Output / Run / Logs), a close button, and a scrolling content area.',
	doc: `\`BottomPanel\` is part of the frozen shell surface, but the current cloud shell layout does NOT mount it — the StatusBar's app-name click is inert there. It exists on the surface for standalone hosts, which mount it themselves between the client area and their status bar and wire its visibility to their own toggle.`,
	docNote: 'Hosted apps never mount BottomPanel or build their own bottom strip - per-item state belongs in the view (StatusBadge), view-level messages in a Banner.',
	demo: BottomPanelDemo,
	code: `// STANDALONE HOSTS ONLY - mounted between the client area and the status
// bar, wired to the host's own visibility toggle.
import { BottomPanel } from 'shell';

{showBottomPanel && <BottomPanel onClose={() => setShowBottomPanel(false)} />}`,
	props: [{ name: 'onClose', type: '() => void', dir: 'out', required: true, note: 'Fired by the panel close button; the host hides the panel.' }],
};
