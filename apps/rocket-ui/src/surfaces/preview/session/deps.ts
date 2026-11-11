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
// DEPS — third-party dependencies in the design loop (fetch + rewrite, no CDN
// imports at runtime)
// =============================================================================

/**
 * Resolution-ladder step 2: a dependency declared in package.json resolves
 * to a LOCKED module-source version whose files are FETCHED (CORS), their
 * internal specifiers and externalized react/react-dom imports REWRITTEN to
 * blob/shim URLs, and the whole subgraph blob-linked exactly like user
 * modules — nothing is ever imported directly from a CDN URL at runtime,
 * and module bytes cache in IndexedDB per URL. Swapping the enterprise npm
 * passthrough in is a pure base-URL change.
 *
 * Versions settle ONCE into the app's lock map (`rr-lock.json` in the VFS
 * — user truth, packed with the source), so the dev preview stays pinned
 * until the user changes them.
 *
 * Editor types are NOT this module's job: automatic type acquisition
 * (ata.ts) downloads .d.ts graphs straight from the source text's imports,
 * declared or not.
 */

import { init as initLexer, parse as parseModule } from 'es-module-lexer';
import type { PackageJsonLike } from 'shared/tools/appdev';
import { getWorkspaceVfs } from '../../workspace/vfs/workspace';
import { cacheGet, cachePut } from './idbCache';
import { mintBlob, mintShareShim } from './linker';

// =============================================================================
// TYPES
// =============================================================================

/** The dependency resolver handed to the linker. */
export interface DependencySet {
	/** Resolves a bare specifier to its linked blob URL (null = undeclared). */
	resolve: (specifier: string) => string | null;
	/** Problems collected while preparing (missing deps, fetch failures). */
	problems: string[];
}

/** The base module-source URL (the enterprise passthrough swaps in here). */
const BASE_URL = 'https://esm.sh';

/** Bare names the dep graph resolves from the share scope, not the source. */
const EXTERNAL_SHARES = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'];

/** Graph ceiling — defense, not policy. */
const MAX_MODULES_PER_DEP = 200;

// =============================================================================
// LOCK MAP
// =============================================================================

/** The lock file's VFS path (inside the app folder — user truth). */
const LOCK_FILE = 'rr-lock.json';

/**
 * Reads the app's lock map ({} when absent) — through the workspace view,
 * so a staged (uncommitted) lock file resolves exactly like a saved one.
 *
 * @param folder - The app's .appdev folder name.
 */
async function readLockMap(folder: string): Promise<Record<string, string>> {
	try {
		return JSON.parse(String(await getWorkspaceVfs().read(`apps/${folder}/${LOCK_FILE}`))) as Record<string, string>;
	} catch {
		return {};
	}
}

/**
 * Settles one dependency's exact version into the lock map: the module
 * source resolves the range once, and the answer is persisted. The DECLARED
 * range is stored next to the version (under `<name>#range`) — editing
 * package.json from "^4" to "^5" must re-settle, not keep serving the old
 * lock silently.
 *
 * @param folder - The app's .appdev folder name.
 * @param name - Package name.
 * @param range - The declared range.
 * @param lock - The current lock map (mutated + persisted on change).
 * @returns The exact version.
 */
async function settleVersion(folder: string, name: string, range: string, lock: Record<string, string>): Promise<string> {
	const existing = lock[name];
	const rangeKey = `${name}#range`;
	if (existing && lock[rangeKey] === (range || 'latest')) return existing;
	const response = await fetch(`${BASE_URL}/${name}@${encodeURIComponent(range || 'latest')}/package.json`);
	if (!response.ok) throw new Error(`Cannot resolve ${name}@${range || 'latest'}: registry answered ${response.status}.`);
	const pkg = (await response.json()) as { version?: string };
	if (!pkg.version) throw new Error(`Cannot resolve ${name}@${range || 'latest'}: no version in its package.json.`);
	lock[name] = pkg.version;
	lock[rangeKey] = range || 'latest';
	await getWorkspaceVfs().write(`apps/${folder}/${LOCK_FILE}`, `${JSON.stringify(lock, null, '\t')}\n`);
	return pkg.version;
}

// =============================================================================
// MODULE GRAPH (fetch + rewrite + blob)
// =============================================================================

/** Fetches one module source, IndexedDB-cached per URL. */
async function fetchModule(url: string): Promise<string> {
	const cached = await cacheGet<string>('deps', url);
	if (cached !== undefined) return cached;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
	const text = await response.text();
	void cachePut('deps', url, text);
	return text;
}

/**
 * Links one dependency's whole module graph to blob URLs (post-order DFS,
 * fetch-and-rewrite). Cycles are refused — a diagnostic beats a deadlock.
 *
 * @param entryUrl - The dependency's entry module URL.
 * @param shims - Reserved-share shim URLs (react/react-dom/...).
 * @returns The entry blob URL.
 */
async function linkDependencyGraph(entryUrl: string, shims: Map<string, string>): Promise<string> {
	await initLexer;
	/** url -> blob url. */
	const linked = new Map<string, string>();
	const visiting = new Set<string>();
	let count = 0;

	const linkOne = async (url: string): Promise<string> => {
		const done = linked.get(url);
		if (done) return done;
		if (visiting.has(url)) throw new Error(`Circular module graph at ${url}.`);
		if (++count > MAX_MODULES_PER_DEP) throw new Error(`Dependency graph exceeds ${MAX_MODULES_PER_DEP} modules.`);
		visiting.add(url);
		let code = await fetchModule(url);
		const [imports] = parseModule(code, url);
		for (let i = imports.length - 1; i >= 0; i -= 1) {
			const imp = imports[i];
			if (imp.d > -1 && imp.n === undefined) continue;
			const specifier = imp.n ?? code.slice(imp.s, imp.e);
			let replacement: string;
			if (EXTERNAL_SHARES.includes(specifier)) {
				const shim = shims.get(specifier);
				if (!shim) throw new Error(`Externalized "${specifier}" has no share shim.`);
				replacement = shim;
			} else if (specifier.startsWith('/')) {
				replacement = await linkOne(`${BASE_URL}${specifier}`);
			} else if (specifier.startsWith('http')) {
				replacement = await linkOne(specifier);
			} else if (specifier.startsWith('.')) {
				replacement = await linkOne(new URL(specifier, url).toString());
			} else {
				throw new Error(`Unexpected bare import "${specifier}" in ${url}.`);
			}
			// step: a dynamic import's s..e spans the QUOTED literal — splice
			// a quoted URL back or `import(blob:…)` is a syntax error
			const text = imp.d > -1 ? JSON.stringify(replacement) : replacement;
			code = `${code.slice(0, imp.s)}${text}${code.slice(imp.e)}`;
		}
		visiting.delete(url);
		const blob = mintBlob(code);
		linked.set(url, blob);
		return blob;
	};

	return linkOne(entryUrl);
}

// =============================================================================
// PREPARE
// =============================================================================

/**
 * Prepares the app's declared dependencies for a link pass: settles
 * versions into the lock map and links every dependency's module graph.
 * Failures per dependency degrade to problems — the rest of the loop keeps
 * working.
 *
 * @param folder - The app's .appdev folder name.
 * @param appId - The app id (shim registry key).
 * @param pkg - The parsed package.json.
 * @param scope - The preview realm's share scope (for the external shims).
 * @returns The dependency set for the linker.
 */
export async function prepareDependencies(folder: string, appId: string, pkg: PackageJsonLike, scope: Record<string, unknown>): Promise<DependencySet> {
	const problems: string[] = [];
	const resolved = new Map<string, string>();

	// step: platform packages never resolve from the registry
	const declared = Object.entries((pkg.dependencies as Record<string, string> | undefined) ?? {}).filter(([name]) => !['react', 'react-dom', 'shell', 'rocketride'].includes(name));
	if (declared.length === 0) {
		return { resolve: () => null, problems };
	}

	// step: mint the external share shims the dep graphs rewrite onto
	const shims = new Map<string, string>();
	for (const name of EXTERNAL_SHARES) {
		const moduleObject = scope[name] as Record<string, unknown> | undefined;
		if (moduleObject) shims.set(name, mintShareShim(appId, name, moduleObject));
	}

	const lock = await readLockMap(folder);
	for (const [name, range] of declared) {
		try {
			const version = await settleVersion(folder, name, range, lock);
			const entryUrl = `${BASE_URL}/${name}@${version}?external=react,react-dom`;
			const blob = await linkDependencyGraph(entryUrl, shims);
			resolved.set(name, blob);
		} catch (err) {
			problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		resolve: (specifier: string) => {
			// subpath imports resolve through the root package for now
			const root = specifier.split('/')[0].startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
			return resolved.get(specifier) ?? resolved.get(root) ?? null;
		},
		problems,
	};
}
