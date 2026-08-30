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
// SHELL FRAME — GALLERY ENTRY (HOST CHROME OVERVIEW)
// =============================================================================

/** Overview gallery entry for the shell frame: the zones and who owns what. */

import React from 'react';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';
import { FrameSchematic } from './demos/FrameSchematic';

/** Schematic demo: map mode — every default-frame zone labeled. */
const ShellFrameDemo: React.FC<IGalleryDemoProps> = () => <FrameSchematic highlight={[]} />;

/** The Shell frame overview gallery entry. */
export const shellFrameEntry: IGalleryEntry = {
	id: 'shell-frame',
	name: 'Shell frame',
	group: 'chrome',
	blurb: 'The standard application frame: Sidebar, client area with the DocTabs strip, StatusBar, and the shell-owned overlays. The map of what the shell owns and where an app renders.',
	doc: `The frame has four standing zones plus on-demand surfaces:

- **Sidebar** — shell-owned container (fixed header + footer) with ONE app-fillable scrolling slot; see the *Sidebar frame* entry.
- **Client area** — the app's canvas. Everything an app renders lives here, under the DocTabs strip (tabbed apps) and above the StatusBar.
- **StatusBar** — the one global connection status line; see the *StatusBar* entry.
- **Overlays** — Account / Settings / Environment / Checkout dialogs the shell renders above everything; see the *Overlay system* entry.
- **Debug panel** — the right-docked ALT+D event trace; see the *Debug panel* entry.

Ownership is one-way: the shell mounts the frame and the app fills the client area and the sidebar slot. In the hosted cloud an app NEVER renders \`Shell\` — the platform bootstraps it and mounts the active app inside. Only a standalone host (its own repo, own bootstrap) mounts \`Shell\` itself, passing the full \`ShellConfig\` it assembled.

\`Shell\` is also the auth orchestrator: before the frame appears it initializes the \`ConnectionManager\`, runs the auth bootstrap, and renders the pre-shell phase screens (loading, sign-in, error, goodbye, waitlisted) on its own.`,
	docNote: 'Hosted apps never mount Shell, never draw frame chrome, and never build lookalike zones - the app fills the client area and the sidebar slot; the shell owns the rest.',
	demo: ShellFrameDemo,
	code: `// STANDALONE HOSTS ONLY - the one Shell mount in a host's bootstrap.
// Hosted (cloud) apps never render Shell; the platform mounts it.
import { Shell } from 'shell';

<Shell config={shellConfig} />`,
	props: [{ name: 'config', type: 'ShellConfig', dir: 'in', required: true, note: 'Full shell configuration assembled by the host bootstrap: branding, theme, account, auth, and app registration.' }],
};
