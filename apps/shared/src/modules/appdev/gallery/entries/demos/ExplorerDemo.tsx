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
// EXPLORER — LAZY GALLERY DEMO
// =============================================================================

/**
 * Lazily-loaded Explorer demo: a small in-memory entry tree drives the real
 * VFS-backed tree component. The host contract keeps `vfs` required, so the
 * demo passes the stock NOOP_VFS exactly like display-only hosts do.
 */

import React, { useState } from 'react';
import { Explorer, NOOP_VFS } from 'shell';
import type { ExplorerEntry } from 'shell';
import type { IGalleryDemoProps } from '../../galleryTypes';

/** The demo's in-memory document tree - S3-style flat paths. */
const DEMO_ENTRIES: ExplorerEntry[] = [
	{
		path: 'chat.pipe',
		children: [
			{ id: 'webhook', name: 'Webhook', provider: 'webhook' },
			{ id: 'chat', name: 'Chat', provider: 'chat' },
		],
	},
	{ path: 'ingest/analyze.pipe' },
	{ path: 'ingest/classify.pipe' },
	{ path: 'archive', type: 'dir' },
];

/** Live demo: the Explorer over the in-memory tree, with local selection. */
const ExplorerDemo: React.FC<IGalleryDemoProps> = () => {
	const [activeFilePath, setActiveFilePath] = useState('chat.pipe');
	return (
		<div style={{ width: 250, border: '1px solid var(--rr-border)', borderRadius: 6, background: 'var(--rr-bg-surface-alt)', padding: '6px 0' }}>
			<Explorer vfs={NOOP_VFS} config={{ title: 'Pipelines', extensions: ['.pipe'], emptyMessage: 'No pipelines' }} entries={DEMO_ENTRIES} isConnected activeFilePath={activeFilePath} onOpenFile={setActiveFilePath} onRefresh={() => undefined} />
		</div>
	);
};

export default ExplorerDemo;
