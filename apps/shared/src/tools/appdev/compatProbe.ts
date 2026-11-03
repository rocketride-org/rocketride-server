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
// COMPAT PROBE — will this npm package run in the browser share-scope world?
// =============================================================================

/**
 * The browser-compat probe, host-agnostic: given a dependency name@version
 * it grades the package `compatible | degraded | incompatible(reasons)` for
 * the App Builder's runtime (browser modules over the shell share scope).
 *
 * Passes:
 *  1. Registry metadata — engines/os pins, browser field hints.
 *  2. Node-builtin graph scan — the served ESM build's import graph is
 *     walked (es-module-lexer on fetched sources) looking for node builtins
 *     that cannot exist in a browser (fs, child_process, net...). TS will
 *     NOT catch this — a typed Node package typechecks fine and dies at
 *     import time.
 *
 * Both hosts run it: edit/add-time surfacing in the web builder, and the
 * deploy-time preflight gate everywhere. The FETCH is injected so the
 * VSCode extension host (Node fetch) and the browser share one probe.
 */

// es-module-lexer is ESM-only: a static import compiles to require() in
// the CommonJS extension-host program (TS1479), and even the TYPE import
// needs an explicit resolution-mode there — the package's lone .d.ts is
// ESM-format (its package.json says type:module), which a CJS-format
// module may only reference with the attribute (TS1542). The dynamic
// import works in every host — Node loads the ESM module, browser
// bundles chunk it.
type LexerModule = typeof import('es-module-lexer', { with: { 'resolution-mode': 'import' } });
let lexerPromise: Promise<LexerModule> | null = null;

/** Loads (once) and initializes the lexer. */
async function loadLexer(): Promise<LexerModule> {
	if (!lexerPromise) {
		lexerPromise = import('es-module-lexer').then(async (mod) => {
			await mod.init;
			return mod;
		});
	}
	return lexerPromise;
}

// =============================================================================
// TYPES
// =============================================================================

/** One probe verdict. */
export interface CompatVerdict {
	/** The grade. */
	verdict: 'compatible' | 'degraded' | 'incompatible';
	/** WHY, human-readable — required for anything but 'compatible'. */
	reasons: string[];
}

/** Options for {@link probePackage}. */
export interface ProbeOptions {
	/** Package name. */
	name: string;
	/** Exact or ranged version ('' = latest). */
	version: string;
	/** Fetch implementation (host-injected; defaults to global fetch). */
	fetchText?: (url: string) => Promise<{ ok: boolean; status: number; text: string }>;
	/** Base URL of the module source (default https://esm.sh; the enterprise
	 * npm passthrough swaps in here). */
	baseUrl?: string;
	/** Graph fetch ceiling (defense against pathological graphs). */
	maxModules?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Node builtins that have no browser existence (with/without node: prefix). */
const NODE_BUILTINS = new Set([
	'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** Builtins that DEGRADE rather than kill (esm.sh ships browser shims). */
const SHIMMABLE_BUILTINS = new Set(['buffer', 'events', 'process', 'util', 'path', 'querystring', 'url', 'string_decoder', 'console', 'assert']);

// =============================================================================
// PROBE
// =============================================================================

/** The default fetch adapter over the global fetch. */
async function defaultFetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
	const response = await fetch(url);
	return { ok: response.ok, status: response.status, text: response.ok ? await response.text() : '' };
}

/**
 * Grades one package (see the module doc).
 *
 * @param options - See {@link ProbeOptions}.
 * @returns The verdict with reasons.
 */
export async function probePackage(options: ProbeOptions): Promise<CompatVerdict> {
	const { name, version } = options;
	const fetchText = options.fetchText ?? defaultFetchText;
	const baseUrl = (options.baseUrl ?? 'https://esm.sh').replace(/\/$/, '');
	const maxModules = options.maxModules ?? 120;
	const reasons: string[] = [];
	let degraded = false;

	const spec = version ? `${name}@${version}` : name;

	// ── Pass 1: registry metadata ────────────────────────────────────────
	try {
		const pkgRes = await fetchText(`${baseUrl}/${spec}/package.json`);
		if (pkgRes.ok) {
			const pkg = JSON.parse(pkgRes.text) as { os?: string[]; engines?: Record<string, string>; browser?: unknown };
			if (Array.isArray(pkg.os) && pkg.os.length > 0) {
				return { verdict: 'incompatible', reasons: [`Declares os=[${pkg.os.join(', ')}] — an OS-pinned native package.`] };
			}
		}
	} catch { /* metadata pass is advisory — the graph scan decides */ }

	// ── Pass 2: node-builtin graph scan over the served ESM build ───────
	const { parse: parseModule } = await loadLexer();
	const visited = new Set<string>();
	const queue = [`${baseUrl}/${spec}?external=react,react-dom`];
	const builtinsHit = new Set<string>();
	while (queue.length > 0 && visited.size < maxModules) {
		const url = queue.shift();
		if (!url || visited.has(url)) continue;
		visited.add(url);
		let body: { ok: boolean; status: number; text: string };
		try {
			body = await fetchText(url);
		} catch (err) {
			// step: a transport failure says nothing about the PACKAGE — the
			// probe is degraded (unverifiable), not the dependency incompatible
			return { verdict: 'degraded', reasons: [`Cannot fetch the browser build (${url}): ${err instanceof Error ? err.message : String(err)}.`] };
		}
		if (!body.ok) {
			// step: only a definite 404 proves there is no servable browser
			// build; 5xx/429/auth walls are transient server states
			if (body.status === 404) {
				return { verdict: 'incompatible', reasons: [`The module source returned ${body.status} for ${url} — no servable browser build.`] };
			}
			return { verdict: 'degraded', reasons: [`The module source returned ${body.status} for ${url} — compatibility could not be verified.`] };
		}
		let imports;
		try {
			[imports] = parseModule(body.text, url);
		} catch {
			// Non-ESM payloads (rare wrapper responses) end this branch.
			continue;
		}
		for (const imp of imports) {
			const specifier = imp.n;
			if (!specifier) continue;
			// step: esm.sh serves builtins as absolute paths too ("/node/fs.mjs",
			// versioned "/v135/node/fs.mjs") — normalize those BEFORE the builtin
			// check or a non-shimmable builtin rides the fetch queue past the gate
			const nodePath = /^\/(?:v\d+\/)?node\/([a-z_0-9]+)(?:\.m?js)?$/.exec(specifier)?.[1];
			const bare = nodePath ?? specifier.replace(/^node:/, '');
			if (NODE_BUILTINS.has(bare)) {
				builtinsHit.add(bare);
			} else if (specifier.startsWith('/')) {
				queue.push(`${baseUrl}${specifier}`);
			} else if (specifier.startsWith('http')) {
				queue.push(specifier);
			}
			// bare react/react-dom externals resolve from the share scope.
		}
	}
	if (visited.size >= maxModules) {
		degraded = true;
		reasons.push(`Import graph exceeds ${maxModules} modules — scan truncated.`);
	}

	const hard = [...builtinsHit].filter((b) => !SHIMMABLE_BUILTINS.has(b));
	const soft = [...builtinsHit].filter((b) => SHIMMABLE_BUILTINS.has(b));
	if (hard.length > 0) {
		return { verdict: 'incompatible', reasons: [`Imports Node-only builtins: ${hard.join(', ')} — these do not exist in the browser.`, ...reasons] };
	}
	if (soft.length > 0) {
		degraded = true;
		reasons.push(`Relies on shimmed Node builtins (${soft.join(', ')}) — works, with shim semantics.`);
	}

	return degraded ? { verdict: 'degraded', reasons } : { verdict: 'compatible', reasons: [] };
}
