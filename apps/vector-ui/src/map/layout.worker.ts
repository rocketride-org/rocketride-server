// =============================================================================
// MIT License
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
// MAP - THE LAYOUT WORKER ENTRY (bundled as its own chunk by Rspack)
// =============================================================================
//
// Binds the layout server to the worker scope. This file and what it imports
// (the layouts, t-SNE, the quality measure, d3-force) form the worker chunk;
// nothing of React, the shell or the shared library may be imported here.
// =============================================================================

import { createLayoutServer } from './layout.server';
import type { LayoutWorkerIn, LayoutWorkerOut } from './protocol';

/** The slice of the worker global this file uses (the DOM lib types `self` as a Window). */
const scope = self as unknown as {
	onmessage: ((event: { data: LayoutWorkerIn }) => void) | null;
	postMessage(message: LayoutWorkerOut): void;
};

const server = createLayoutServer({
	post: (message) => scope.postMessage(message),
	now: () => performance.now(),
	yieldToQueue: () => new Promise((resolve) => setTimeout(resolve, 0)),
});

scope.onmessage = (event) => server.receive(event.data);
