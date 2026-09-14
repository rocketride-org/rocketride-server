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
// OVERLAY SYSTEM — GALLERY ENTRY (DOC-ONLY, HOST CHROME)
// =============================================================================

/** Gallery entry for the shell-owned overlay dialogs. */

import React from 'react';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';
import { FrameSchematic } from './demos/FrameSchematic';

/** Schematic demo: an overlay dialog above the dimmed client area. */
const OverlaySystemDemo: React.FC<IGalleryDemoProps> = () => <FrameSchematic highlight="overlay" />;

/** The Overlay system gallery entry. */
export const overlaySystemEntry: IGalleryEntry = {
	id: 'overlay-system',
	name: 'Overlay system',
	group: 'chrome',
	blurb: 'The shell-owned modal dialogs - Account, Settings, Environment, and the Checkout flow - rendered above the client area on a dimmed backdrop.',
	doc: `The pages inside the overlays are ordinary views (their sub-pages use the ordinary \`TabControl\`), but the dialogs themselves belong to the shell: apps never create overlays, they may only **ask** the shell to open one by emitting \`shell:openOverlay\` on the \`ConnectionManager\`. Unknown ids are ignored (guarded allowlist), and opening one overlay closes any other.

For the app's OWN records — inspect, edit, create — use a \`DetailPanel\` record panel instead; app-side modals are only for confirmations (\`ConfirmDialog\`) and multi-step flows (\`Modal\`).`,
	docNote: 'Overlay dialogs render OUTSIDE the client area\'s providers - components inside them cannot rely on app-side context.',
	demo: OverlaySystemDemo,
	code: `// Deep-link into a shell overlay from anywhere in an app. The shell's
// OverlayManager listens for this and opens the same dialog the sidebar
// footer opens. Unknown ids are ignored (guarded allowlist).
import { ConnectionManager } from 'shell';

ConnectionManager.getInstance().emit('shell:openOverlay', { id: 'account' });`,
	propsLabel: 'Events',
	props: [
		{ name: 'shell:openOverlay', type: "{ id: 'account' | 'settings' | 'environment' }", dir: 'in', note: 'Emit on the ConnectionManager to request an overlay; part of ShellEventMap. Opening one overlay closes any other.' },
	],
};
