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
// MONACO LOADER — the ONE way the platform loads Monaco (bundled, lazy)
// =============================================================================

/**
 * Loads the BUNDLED Monaco build behind a lazy boundary: the editor and its
 * workers are chunks of the consuming remote's own bundle, emitted at
 * platform build time and served from the remote's prefix. No
 * `@monaco-editor/react`, no `@monaco-editor/loader`, no CDN — anywhere.
 *
 * `editor.main` is imported (API + languages + editor features) so every
 * platform surface — the App Builder Code pane, the Explorer viewer, the
 * SQL editor — gets one consistent feature set from one chunk.
 */

import { ensureMonacoEnvironment } from './environment';

/** The Monaco API namespace type (type-only import — no eager bytes). */
export type Monaco = typeof import('monaco-editor');

/** The memoized load. */
let monacoPromise: Promise<Monaco> | null = null;

/**
 * Loads Monaco once (workers wired first) and memoizes the namespace.
 *
 * @returns The Monaco API namespace.
 */
export function loadMonaco(): Promise<Monaco> {
	if (!monacoPromise) {
		// step: workers MUST be wired before the first editor import runs
		ensureMonacoEnvironment();
		monacoPromise = import('monaco-editor/esm/vs/editor/editor.main.js').then((m) => m as unknown as Monaco);
	}
	return monacoPromise;
}
