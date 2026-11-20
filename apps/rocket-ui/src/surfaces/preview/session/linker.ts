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
// LINKER — emitted modules -> blob-URL ES module graph (no bundler, ever)
// =============================================================================

/**
 * Links the TS worker's per-file JS output into a runnable ES module graph:
 * relative specifiers become content-addressed blob URLs (bottom-up,
 * topological), reserved bare names (react, react-dom, the jsx runtimes,
 * shell, rocketride) become SHIM modules reading the preview realm's dev
 * share scope, and css imports become style-injection modules. The result
 * is one entry blob URL whose import() yields the app's AppDescriptor.
 *
 * Scope hand-off: blob modules cannot close over variables, so each link
 * publishes its share scope + css target on `window.__rrAppDevScopes` and
 * the generated shims read it back by app id. The scope OBJECTS come from
 * the preview iframe's `__rrShellDev.getShareScope()` — the components the
 * user's code creates always bind the preview realm's React.
 */

import { init as initLexer, parse as parseModule } from 'es-module-lexer';

// =============================================================================
// TYPES
// =============================================================================

/** One emitted module handed to the linker. */
export interface LinkModule {
	/** The emitted (and possibly instrumented) JavaScript. */
	js: string;
	/** The source map JSON text, when emitted. */
	map?: string;
}

/** One linker diagnostic. */
export interface LinkError {
	/** The importing module's project-relative path. */
	path: string;
	/** Human-readable problem ("Cannot resolve './Foo'", ...). */
	message: string;
}

/** The linked graph. */
export interface LinkResult {
	/** The entry module's blob URL ('' when linking failed). */
	entryUrl: string;
	/** Every minted blob URL, entry included (revoke after replacing). */
	blobUrls: string[];
	/** Per-module blob URLs, keyed by project-relative path. */
	moduleUrls: Map<string, string>;
	/** Reserved-share shim URLs, keyed by bare name (HMR relinks reuse them). */
	shimUrls: Map<string, string>;
	/** Diagnostics (non-empty means the graph is not runnable). */
	errors: LinkError[];
}

/** Inputs for {@link linkModules}. */
export interface LinkOptions {
	/** The app id (namespaces the scope registry entry). */
	appId: string;
	/** Emitted modules keyed by project-relative SOURCE path (src/App.tsx). */
	modules: Map<string, LinkModule>;
	/** The entry module's source path (src/AppDescriptor.ts). */
	entryPath: string;
	/** The preview realm's dev share scope (getShareScope()). */
	scope: Record<string, unknown>;
	/** Document that receives css <style> injections (the preview iframe's). */
	cssDocument: Document | null;
	/**
	 * Phase-4 hook: resolves a NON-RESERVED bare specifier to an already
	 * linked dependency blob URL, or null when the dependency is unknown
	 * (which surfaces as a diagnostic).
	 */
	resolveDependency?: (specifier: string) => string | null;
	/**
	 * Already-linked module URLs to reuse verbatim (hot swap): seeded paths
	 * short-circuit linkOne, so ONLY the unseeded modules mint new blobs and
	 * re-evaluate. Reused URLs are never added to the result's blobUrls —
	 * revoking the link must not kill URLs an earlier link still owns.
	 */
	preLinked?: Map<string, string>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Reserved bare names served from the dev share scope, never fetched. */
export const RESERVED_SHARES = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'shell', 'rocketride'] as const;

/** Global registry key the generated shims read the scope back through. */
const SCOPE_REGISTRY = '__rrAppDevScopes';

/** Identifier shape a named re-export can carry. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// =============================================================================
// HELPERS
// =============================================================================

/** Ensures the lexer's wasm is initialized (idempotent). */
export async function ensureLexer(): Promise<void> {
	await initLexer;
}

/**
 * Resolves a relative specifier against the importer's path over the
 * module map (extension + index resolution, like a bundler would).
 *
 * @param importer - The importing module's project-relative path.
 * @param specifier - The relative specifier ('./App', '../util/x.ts').
 * @param modules - The module map (source paths).
 * @returns The resolved source path, or null.
 */
function resolveRelative(importer: string, specifier: string, modules: Map<string, LinkModule>): string | null {
	// step: join + normalize the path segments
	const base = importer.split('/').slice(0, -1);
	for (const seg of specifier.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') base.pop();
		else base.push(seg);
	}
	const joined = base.join('/');
	// step: exact, then extension, then index resolution
	const candidates = [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.jsx`, `${joined}.css`, `${joined}/index.ts`, `${joined}/index.tsx`];
	for (const candidate of candidates) {
		if (modules.has(candidate)) return candidate;
	}
	return null;
}

/**
 * Generates the shim module text for one reserved share: named exports are
 * enumerated from the LIVE module object at link time, so the shim mirrors
 * exactly what the share scope serves.
 *
 * @param appId - The app id (registry key).
 * @param name - The reserved bare name.
 * @param moduleObject - The live module from the share scope.
 * @returns The shim module source.
 */
function shimSource(appId: string, name: string, moduleObject: Record<string, unknown>): string {
	const access = `window.${SCOPE_REGISTRY}[${JSON.stringify(appId)}].scope[${JSON.stringify(name)}]`;
	const lines = [`const m = ${access};`];
	for (const key of Object.keys(moduleObject)) {
		if (key === 'default' || !IDENT_RE.test(key)) continue;
		lines.push(`export const ${key} = m[${JSON.stringify(key)}];`);
	}
	lines.push(`export default ('default' in m ? m['default'] : m);`);
	return lines.join('\n');
}

/**
 * Generates the style-injection module for a css file: (re)places one
 * <style> tag, id-keyed by path, into the preview document.
 *
 * @param appId - The app id (registry key).
 * @param path - The css file's project-relative path.
 * @param css - The stylesheet text.
 * @returns The injector module source.
 */
function cssInjectorSource(appId: string, path: string, css: string): string {
	return [
		`const doc = window.${SCOPE_REGISTRY}[${JSON.stringify(appId)}].cssDocument;`,
		`if (doc) {`,
		`\tconst id = ${JSON.stringify(`rr-appdev-css:${appId}:${path}`)};`,
		`\tlet el = doc.getElementById(id);`,
		`\tif (!el) { el = doc.createElement('style'); el.id = id; doc.head.appendChild(el); }`,
		`\tel.textContent = ${JSON.stringify(css)};`,
		`}`,
		`export default undefined;`,
	].join('\n');
}

/**
 * Mints a blob URL for module source, appending the inline sourcemap (when
 * present) so DevTools maps frames back to the VFS sources. Exported for
 * the HMR path's single-module re-links.
 *
 * @param source - The module JavaScript.
 * @param map - Optional source map JSON.
 * @returns The blob URL.
 */
export function mintBlob(source: string, map?: string): string {
	let text = source;
	if (map) {
		const b64 = btoa(unescape(encodeURIComponent(map)));
		text += `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}`;
	}
	return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
}

/**
 * Mints a standalone reserved-share shim (the dependency loader uses these
 * so fetched third-party modules resolve their externalized react imports
 * to the SAME share-scope shims user code gets — and the blobs survive
 * across relinks for caching).
 *
 * @param appId - The app id (registry key).
 * @param name - The reserved bare name.
 * @param moduleObject - The live module from the share scope.
 * @returns The shim blob URL.
 */
export function mintShareShim(appId: string, name: string, moduleObject: Record<string, unknown>): string {
	return mintBlob(shimSource(appId, name, moduleObject));
}

// =============================================================================
// LINK
// =============================================================================

/**
 * Links the emitted module graph (see the module doc).
 *
 * @param options - See {@link LinkOptions}.
 * @returns The linked graph (errors non-empty on failure — no partial run).
 */
export async function linkModules(options: LinkOptions): Promise<LinkResult> {
	await ensureLexer();
	const { appId, modules, entryPath, scope, cssDocument, resolveDependency } = options;
	const errors: LinkError[] = [];
	const blobUrls: string[] = [];
	const moduleUrls = new Map<string, string>(options.preLinked ?? []);
	/** Reserved-share shim URLs, one per name per link. */
	const shimUrls = new Map<string, string>();

	// step: publish this link's scope + css target for the generated shims.
	// MERGE over the existing entry — the dev session parks its refresh
	// runtime on the same registry row, and a relink must not clobber it.
	const registry = (window as unknown as Record<string, Record<string, Record<string, unknown>>>)[SCOPE_REGISTRY] ?? {};
	(window as unknown as Record<string, unknown>)[SCOPE_REGISTRY] = registry;
	registry[appId] = { ...(registry[appId] ?? {}), scope, cssDocument };

	/** Lazily mints one reserved share's shim. */
	const shimFor = (name: string): string | null => {
		const existing = shimUrls.get(name);
		if (existing) return existing;
		const moduleObject = scope[name] as Record<string, unknown> | undefined;
		if (!moduleObject) return null;
		const url = mintBlob(shimSource(appId, name, moduleObject));
		shimUrls.set(name, url);
		blobUrls.push(url);
		return url;
	};

	/** DFS state for cycle detection. */
	const visiting = new Set<string>();

	/**
	 * Links one module (post-order DFS), returning its blob URL.
	 *
	 * @param path - The module's source path.
	 */
	const linkOne = (path: string): string | null => {
		const done = moduleUrls.get(path);
		if (done) return done;
		if (visiting.has(path)) {
			errors.push({ path, message: `Circular import chain through "${path}" — the design loop links acyclic graphs.` });
			return null;
		}
		visiting.add(path);
		const mod = modules.get(path);
		if (!mod) {
			visiting.delete(path);
			errors.push({ path, message: `No emitted output for "${path}".` });
			return null;
		}

		// step: css modules become style injectors — no import rewriting
		if (path.endsWith('.css')) {
			const url = mintBlob(cssInjectorSource(appId, path, mod.js));
			moduleUrls.set(path, url);
			blobUrls.push(url);
			visiting.delete(path);
			return url;
		}

		// step: parse imports and rewrite specifiers back-to-front (string
		// surgery keeps every other byte identical, so sourcemaps stay valid
		// for everything on the same line before the specifier only — which
		// is why the rewrite preserves specifier LENGTH ordering back-first)
		let code = mod.js;
		let imports;
		try {
			[imports] = parseModule(code, path);
		} catch (err) {
			visiting.delete(path);
			errors.push({ path, message: `Parse failed: ${err instanceof Error ? err.message : String(err)}` });
			return null;
		}
		for (let i = imports.length - 1; i >= 0; i -= 1) {
			const imp = imports[i];
			// dynamic-import expressions without a static specifier ride as-is
			if (imp.d > -1 && imp.n === undefined) continue;
			const specifier = imp.n ?? code.slice(imp.s, imp.e);
			let replacement: string | null = null;
			if (specifier.startsWith('.')) {
				const resolved = resolveRelative(path, specifier, modules);
				replacement = resolved ? linkOne(resolved) : null;
				if (!resolved) errors.push({ path, message: `Cannot resolve "${specifier}" from "${path}".` });
			} else if ((RESERVED_SHARES as readonly string[]).includes(specifier)) {
				replacement = shimFor(specifier);
				if (!replacement) errors.push({ path, message: `The preview's share scope does not provide "${specifier}" — reload the preview (older shell?).` });
			} else {
				replacement = resolveDependency?.(specifier) ?? null;
				if (!replacement) errors.push({ path, message: `"${specifier}" is not a declared dependency. Add it to package.json dependencies.` });
			}
			if (replacement) {
				// step: a dynamic import's s..e spans the QUOTED literal —
				// splice a quoted URL back or `import(blob:…)` is a syntax error
				const text = imp.d > -1 ? JSON.stringify(replacement) : replacement;
				code = `${code.slice(0, imp.s)}${text}${code.slice(imp.e)}`;
			}
		}
		visiting.delete(path);
		if (errors.length > 0) return null;

		const url = mintBlob(code, mod.map);
		moduleUrls.set(path, url);
		blobUrls.push(url);
		return url;
	};

	const entryUrl = linkOne(entryPath) ?? '';
	return { entryUrl: errors.length === 0 ? entryUrl : '', blobUrls, moduleUrls, shimUrls, errors };
}

/**
 * Revokes a previous link's blob URLs (call after the replacement link is
 * registered — in-flight imports of the OLD graph must finish first, so
 * revocation is deferred a tick by the caller).
 *
 * @param urls - The blob URLs to revoke.
 */
export function revokeLink(urls: string[]): void {
	for (const url of urls) {
		try {
			URL.revokeObjectURL(url);
		} catch { /* already revoked */ }
	}
}
