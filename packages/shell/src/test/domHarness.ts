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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// DOM HARNESS — a happy-dom window registered as globals (PR2b, plan section 3.7)
// =============================================================================
//
// `installDom()` makes a `happy-dom` window THE `window`/`document` of the test
// process; `render()` mounts a React 18 element with `react-dom/client` inside
// `act`. `happy-dom` is a devDependency of `shell` (and `rocket-ui`), pinned to
// an exact version (package.json and the lockfile are the implementation's to
// update: this commit adds the harness only).
// =============================================================================

/// <reference types="node" />

import Module from 'node:module';
import { Window } from 'happy-dom';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

/** The globals the shell code under test reads. */
const GLOBALS = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'MessageEvent', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

/**
 * Makes `require('x.css')` and the other asset kinds the shell's barrel pulls in
 * (`allotment` ships a stylesheet) resolve to an empty module under node.
 */
export function ignoreAssets(): void {
	const ext = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }) => void> })._extensions;
	for (const e of ['.css', '.svg', '.png', '.jpg', '.woff', '.woff2', '.ttf']) ext[e] = (m) => void (m.exports = {});
}

/** An installed DOM. `cleanup` restores the globals it replaced. */
export interface IDom {
	window: Window;
	cleanup(): void;
}

/** Registers a fresh happy-dom window (at `url`) as the process globals. */
export function installDom(url = 'http://localhost:5565/'): IDom {
	ignoreAssets();
	const window = new Window({ url });
	const g = globalThis as unknown as Record<string, unknown>;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const name of ['IS_REACT_ACT_ENVIRONMENT', ...GLOBALS]) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	g.IS_REACT_ACT_ENVIRONMENT = true;
	for (const name of GLOBALS) {
		const value = name === 'window' ? window : (window as unknown as Record<string, unknown>)[name];
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	}
	return {
		window,
		cleanup() {
			for (const [name, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete g[name];
			}
			void window.happyDOM.close();
		},
	};
}

/** Runs `fn` inside React's `act` and flushes effects. */
export async function act(fn: () => void | Promise<void>): Promise<void> {
	await (React as unknown as { act(cb: () => void | Promise<void>): Promise<void> }).act(fn);
}

/** A mounted tree. */
export interface IRendered {
	container: HTMLElement;
	rerender(element: React.ReactElement): Promise<void>;
	unmount(): Promise<void>;
}

/** Mounts `element` into a fresh container of the installed document. */
export async function render(element: React.ReactElement): Promise<IRendered> {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	await act(() => root.render(element));
	return {
		container,
		rerender: (next) => act(() => root.render(next)),
		unmount: async () => {
			await act(() => root.unmount());
			container.remove();
		},
	};
}
