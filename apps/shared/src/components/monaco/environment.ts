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
// MONACO ENVIRONMENT — self-hosted worker wiring (no CDN, ever)
// =============================================================================

/**
 * Installs `self.MonacoEnvironment` BEFORE the editor loads: every Monaco
 * worker is a chunk of the CONSUMING remote's own bundle, emitted by the
 * bundler's worker parser (`new Worker(new URL(...))`) and served from the
 * remote's own prefix. CLASSIC workers, not `{type:'module'}` — the app
 * family's browserslist floor includes safari >= 13 and module workers are
 * Safari 15+.
 */

/**
 * A Worker that survives a cross-origin script URL. Same-origin scripts
 * construct directly. Cross-origin ones — the dev-remote case, where the
 * bundle (and so its worker chunks) serves from the rsbuild dev server's
 * origin while the page is the shell's — go through a same-origin blob
 * trampoline that importScripts() the real URL: Worker CONSTRUCTION is
 * hard same-origin (CORS cannot allow it), importScripts is not. Classic
 * workers only — importScripts does not exist in module workers, which is
 * fine here (see the module doc: this wiring is classic by design).
 *
 * Caveat carried knowingly: inside a trampolined worker self.location is
 * the blob URL, so a worker chunk that lazy-loads NESTED chunks under an
 * 'auto' publicPath would mis-resolve them. The Monaco workers are
 * single-chunk, so the path never runs today.
 */
class CrossOriginWorker extends Worker {
	constructor(scriptURL: string | URL, options?: WorkerOptions) {
		const resolved = new URL(String(scriptURL), self.location.href);
		if (resolved.origin === self.location.origin) {
			super(scriptURL, options);
		} else {
			const trampoline = new Blob([`importScripts(${JSON.stringify(resolved.href)});`], { type: 'application/javascript' });
			super(URL.createObjectURL(trampoline), options);
		}
	}
}

/**
 * Wires MonacoEnvironment.getWorker to bundled worker chunks. Idempotent —
 * safe to call before every editor mount.
 */
export function ensureMonacoEnvironment(): void {
	const globalScope = self as unknown as { MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker } };
	if (globalScope.MonacoEnvironment) return;
	globalScope.MonacoEnvironment = {
		getWorker(_id: string, label: string): Worker {
			// step: route construction through CrossOriginWorker for the
			// duration of the (fully synchronous) switch. The bundler's worker
			// parser only emits a worker chunk for the LITERAL
			// `new Worker(new URL(...))` pattern — a named wrapper class at the
			// call sites would stop the chunks being built at all, and a
			// per-consumer parser config would have to ride every rsbuild
			// config that bundles this module. The emitted runtime code
			// resolves `Worker` through the global scope at call time, so a
			// scoped swap routes it; single-threaded JS makes the swap
			// invisible outside this call.
			const scope = self as { Worker: typeof Worker };
			const RealWorker = scope.Worker;
			scope.Worker = CrossOriginWorker;
			try {
				// step: route the language label to its dedicated worker; every
				// other language runs on the base editor worker.
				switch (label) {
					case 'typescript':
					case 'javascript':
						return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url));
					case 'json':
						return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url));
					case 'css':
					case 'scss':
					case 'less':
						return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url));
					case 'html':
					case 'handlebars':
					case 'razor':
						return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url));
					default:
						return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url));
				}
			} finally {
				scope.Worker = RealWorker;
			}
		},
	};
}
