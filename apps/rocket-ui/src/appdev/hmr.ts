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
// HMR — React Fast Refresh over the blob-link loop
// =============================================================================

/**
 * Fast Refresh for the design loop. The mechanism (settled in the plan):
 *
 *  - The dev-flavor preview shell installs a RECORDING devtools hook before
 *    react-dom loads. The builder lazy-loads ITS OWN react-refresh/runtime
 *    copy and attaches it to the PREVIEW realm via
 *    `injectIntoGlobalHook(previewWindow)` — the runtime walks the hook's
 *    recorded renderers retroactively, so late attach is by design (the
 *    VSCode loop exercises the same contract daily).
 *  - Every emitted module is INSTRUMENTED with react-refresh/babel (via
 *    lazy-loaded @babel/standalone — Monaco stays the compiler, babel only
 *    instruments), with registration ids = app-relative path + export name
 *    — stable across blob re-links, which is exactly what restores
 *    component identity.
 *  - A component-only save re-imports JUST that module; its registrations
 *    overwrite the old ids; performReactRefresh() flushes. State survives.
 *  - Root tracking fills on the first COMMIT after attach — the session
 *    forces one (the initial mount) before relying on hot updates.
 *
 * The instrumentation toolchain (@babel/standalone + the plugin + the
 * runtime) is a lazy chunk of this remote — fetched on first use from our
 * origin, never on any production path.
 */

import { parse as parseModule, init as initLexer } from 'es-module-lexer';

/** The runtime surface the session drives. */
export interface RefreshTools {
	/** Attaches the runtime to the preview realm's recorded hook. */
	attach: (previewWindow: Window) => void;
	/** Instruments one emitted module (chaining the input sourcemap).
	 * Returns the linker's module shape ({js, map}) so instrumented output
	 * feeds linkModules directly. `ns` scopes the registration ids to the
	 * CALLING session: the runtime is a page-wide singleton injected into
	 * every preview realm, so two sessions of the SAME app would otherwise
	 * register identical family ids for modules from different graphs —
	 * and a flush then renders one realm's component with the other
	 * realm's React (the "more than one copy of React" hook crash). */
	instrument: (code: string, moduleId: string, map?: string, ns?: string) => { js: string; map?: string };
	/** Flushes pending component swaps. */
	performRefresh: () => void;
}

/** Global the instrumented preludes reach the runtime through. */
const RUNTIME_GLOBAL = '__rrAppDevRefresh';

/** The lazy toolchain load (babel + plugin + runtime in one chunk). */
let toolsPromise: Promise<RefreshTools> | null = null;

/**
 * Loads (once) the Fast Refresh toolchain.
 *
 * @returns The refresh tools.
 */
export function loadRefreshTools(): Promise<RefreshTools> {
	if (!toolsPromise) {
		toolsPromise = Promise.all([
			import('@babel/standalone'),
			// The DEVELOPMENT files, addressed directly: the package entries
			// throw ("React Refresh runtime should not be included in the
			// production bundle") under the builder's production NODE_ENV —
			// dev tooling embedded in a production-shaped build imports past
			// the guard by design. RELATIVE paths (rocket-ui's own declared
			// dep): the package's exports map does not list the cjs files.
			import('../../node_modules/react-refresh/cjs/react-refresh-babel.development.js'),
			import('../../node_modules/react-refresh/cjs/react-refresh-runtime.development.js'),
		]).then(([babel, refreshBabel, runtime]) => {
			// step: expose the runtime for the instrumented preludes (blob
			// modules execute in THIS realm, so this window is theirs)
			(window as unknown as Record<string, unknown>)[RUNTIME_GLOBAL] = runtime;

			const attach = (previewWindow: Window): void => {
				// Late attach by contract: the recorded hook hands the runtime
				// the renderer react-dom injected at preview boot.
				runtime.injectIntoGlobalHook(previewWindow);
			};

			const instrument = (code: string, moduleId: string, map?: string, ns?: string): { js: string; map?: string } => {
				const plugin = (refreshBabel as { default?: unknown }).default ?? refreshBabel;
				const result = babel.transform(code, {
					// emitFullSignatures skips the plugin's require('crypto')
					// hashing path (the builtin is stubbed in the browser bundle).
					plugins: [[plugin, { skipEnvCheck: true, emitFullSignatures: true }]],
					// Parse as plain ESM — the input is the TS worker's OUTPUT.
					sourceType: 'module',
					filename: moduleId,
					sourceMaps: true,
					inputSourceMap: map ? (JSON.parse(map) as object) : undefined,
					// Babel must not transpile — instrumentation only.
					presets: [],
					compact: false,
				});
				// step: prelude — per-module $RefreshReg$/$RefreshSig$ pointing
				// at the shared runtime, ids keyed by the session namespace +
				// the APP-RELATIVE path (stable across re-links WITHIN a
				// session — identity restore — while two sessions of one app
				// can never collide; see the RefreshTools.instrument doc).
				// ONE line + newline, so the sourcemap's line offset is exactly
				// 1 and DevTools stays aligned with the chained map.
				const idBase = ns ? `${ns} ${moduleId}` : moduleId;
				const prelude = `const $rrRt = window.${RUNTIME_GLOBAL}; window.$RefreshReg$ = (type, id) => $rrRt.register(type, ${JSON.stringify(idBase)} + ' ' + id); window.$RefreshSig$ = $rrRt.createSignatureFunctionForTransform;\n`;
				return {
					js: prelude + (result.code ?? code),
					map: result.map ? JSON.stringify(result.map) : map,
				};
			};

			return {
				attach,
				instrument,
				performRefresh: () => runtime.performReactRefresh(),
			};
		});
	}
	return toolsPromise;
}

/**
 * Whether a module's exports look component-only (the Fast Refresh
 * boundary rule): every export name is PascalCase, or the default export.
 * Anything else (hooks, utils, constants) falls back to the full re-link +
 * remount — the valve that keeps refresh semantics honest.
 *
 * @param emittedJs - The module's emitted (pre-instrumentation) JS.
 * @returns True when a lone re-import + refresh is safe.
 */
export async function isComponentOnlyModule(emittedJs: string): Promise<boolean> {
	await initLexer;
	try {
		const [, exports] = parseModule(emittedJs);
		if (exports.length === 0) return false;
		return exports.every((e) => e.n === 'default' || /^[A-Z]/.test(e.n));
	} catch {
		return false;
	}
}
