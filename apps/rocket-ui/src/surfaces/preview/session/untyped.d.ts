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
 * Ambient declarations for the HMR toolchain packages that ship no types.
 * Only the members the dev session actually calls are declared.
 */

declare module '@babel/standalone' {
	/** Babel transform result (the subset the instrumenter reads). */
	export interface BabelTransformResult {
		code: string | null;
		map: object | null;
	}
	/** Runs a transform with the given options. */
	export function transform(code: string, options: Record<string, unknown>): BabelTransformResult;
}

declare module '*react-refresh-babel.development.js' {
	/** The react-refresh babel plugin (opaque — handed to @babel/standalone). */
	const plugin: unknown;
	export default plugin;
}

declare module '*react-refresh-runtime.development.js' {
	/** Attaches the refresh runtime to a realm's devtools hook (retroactively
	 * adopting already-recorded renderers). */
	export function injectIntoGlobalHook(globalObject: unknown): void;
	/** Registers a component implementation under a stable family id. */
	export function register(type: unknown, id: string): void;
	/** The $RefreshSig$ factory the babel plugin's output calls. */
	export function createSignatureFunctionForTransform(): unknown;
	/** Applies pending component swaps to every tracked root. */
	export function performReactRefresh(): void;
}
