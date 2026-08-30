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

/**
 * DEV-FLAVOR entry (RR_SHELL_FLAVOR=dev builds only).
 *
 * Installs a renderer-recording devtools global hook BEFORE react-dom
 * evaluates — the hard ordering requirement: react-dom reads the hook at
 * module-initialization time and registers itself into it. A dev-linked
 * app's own react-refresh runtime then ADOPTS the recorded renderer
 * (react-refresh iterates hook.renderers for exactly this late-attach case)
 * and drives state-preserving hot updates through the shell's development
 * react-dom. No refresh runtime is shared or bundled here — the hook
 * contract is the entire interface. react-dom is an eager MF singleton
 * whose factory first executes inside the async bootstrap chunk, so running
 * this synchronously here wins the race.
 */

// Install a PROPER devtools-style hook — critically, one whose inject()
// RECORDS renderers in hook.renderers, like the real DevTools extension.
// react-refresh's own fallback hook does not (inject is `return nextID++`),
// which leaves hook.renderers empty forever — and a dev-linked app's
// react-refresh runtime adopts existing renderers by iterating exactly that
// map. With this hook: react-dom (dev) registers itself here at load; the
// app's refresh runtime later finds it, adopts it, and hot updates
// re-render in place with component state preserved.
const renderers = new Map<number, unknown>();
let nextRendererId = 0;
(window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
	renderers,
	supportsFiber: true,
	inject(injected: unknown): number {
		const id = ++nextRendererId;
		renderers.set(id, injected);
		return id;
	},
	onScheduleFiberRoot(): void {
		/* refresh runtimes wrap this */
	},
	onCommitFiberRoot(): void {
		/* refresh runtimes wrap this to track roots */
	},
	onCommitFiberUnmount(): void {
		/* refresh runtimes wrap this */
	},
};

// Modules compiled WITHOUT the refresh transform (this shell's own code) may
// still be imported by transformed modules — provide the no-op globals the
// transform's guards expect so untransformed code paths never throw.
(window as unknown as Record<string, unknown>).$RefreshReg$ = () => undefined;
(window as unknown as Record<string, unknown>).$RefreshSig$ = () => (type: unknown) => type;

// Continue into the standard async boundary (same as src/index.tsx) — the MF
// runtime initializes shared singletons before any synchronous imports run.
import('./bootstrap');
