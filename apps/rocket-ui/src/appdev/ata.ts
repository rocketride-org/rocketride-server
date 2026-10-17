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
// ATA — automatic type acquisition for the App Builder editor
// =============================================================================

/**
 * Editor-types engine: @typescript/ata (the TS Playground's acquisition
 * engine) watches the session's source text, extracts its imports, downloads
 * each package's .d.ts graph from jsDelivr, and the files register as Monaco
 * extraLibs at their real node_modules paths — types appear as the user
 * types the import, no declaration required first.
 *
 * Scope boundaries:
 *
 *  - EDITOR ONLY. Runtime module resolution still rides the declared
 *    package.json dependencies through the lock map (deps.ts); an import
 *    that type-checks here but is undeclared still fails to link, and the
 *    linker's marker + add-to-dependencies quick fix remains the bridge.
 *  - The toolchain (typescript + @typescript/ata) loads as a LAZY dynamic
 *    chunk on first use — the App Builder pays for it, the main bundle
 *    does not.
 *  - Downloads cache in IndexedDB per URL (the 'dts' store), so a revisit
 *    acquires from disk, not the network.
 */

import type { TypescriptSetupHandle } from 'shared/modules/monaco';
import { cacheGet, cachePut } from './idbCache';

// =============================================================================
// TYPES
// =============================================================================

/** One session's acquisition engine. */
export interface AtaEngine {
	/**
	 * Schedules an acquisition pass over one source file (debounced; the
	 * supplier is read at fire time so the pass sees the latest content).
	 */
	enqueue: (key: string, getSource: () => string) => void;
	/** Cancels pending work and detaches (registered libs die with the tsHandle). */
	dispose: () => void;
}

/** The acquisition function @typescript/ata hands back. */
type AcquireFn = (sourceCode: string) => void;

/** Keystroke settle time before a pass runs. */
const ATA_DEBOUNCE_MS = 1000;

// =============================================================================
// FETCH (IndexedDB-cached)
// =============================================================================

/**
 * A fetch for ATA whose successful text responses cache in IndexedDB —
 * jsDelivr metadata and .d.ts bodies are immutable enough that a cache hit
 * beats a revalidation every time.
 *
 * @param input - The request URL.
 * @param init - Request init (ATA passes none that matter for caching).
 * @returns The (possibly cache-served) response.
 */
async function cachedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
	const cacheKey = `ata:${url}`;
	const cached = await cacheGet<string>('dts', cacheKey);
	if (cached !== undefined) {
		return new Response(cached, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
	}
	const response = await fetch(input, init);
	if (response.ok) {
		const text = await response.clone().text();
		void cachePut('dts', cacheKey, text);
	}
	return response;
}

// =============================================================================
// ENGINE
// =============================================================================

/**
 * Creates the session's acquisition engine. The toolchain loads lazily on
 * the first enqueue; every failure degrades to a warning — types are an
 * upgrade, never a dependency.
 *
 * @param tsHandle - The session's TS setup handle (extraLib registration).
 * @param onProblem - Sink for user-facing acquisition problems.
 * @returns The engine.
 */
export function createAtaEngine(tsHandle: TypescriptSetupHandle, onProblem: (message: string) => void): AtaEngine {
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** file key -> latest source supplier (read when the debounce fires). */
	const pending = new Map<string, () => string>();
	/** The lazily built acquisition function (null until first use). */
	let acquirePromise: Promise<AcquireFn | null> | null = null;

	// step: build the acquisition function — dynamic imports keep typescript
	// and the ATA engine out of the main bundle
	const loadAcquire = async (): Promise<AcquireFn | null> => {
		try {
			const [tsModule, ataModule] = await Promise.all([import('typescript'), import('@typescript/ata')]);
			return ataModule.setupTypeAcquisition({
				projectName: 'rr-appdev',
				typescript: tsModule.default ?? (tsModule as unknown as typeof import('typescript')),
				fetcher: cachedFetch,
				delegate: {
					// step: every downloaded .d.ts registers at its real
					// node_modules path, through the session handle so the libs
					// dispose with the session
					receivedFile: (code: string, path: string) => {
						if (!disposed) tsHandle.addExtraLib(code, `file://${path}`);
					},
					errorMessage: (message: string) => {
						onProblem(`[types] ${message}`);
					},
				},
			});
		} catch (err) {
			onProblem(`[types] automatic type acquisition unavailable: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	};

	// step: the debounce body — one pass over every pending file's current text
	const fire = async (): Promise<void> => {
		const batch = [...pending.values()];
		pending.clear();
		acquirePromise ??= loadAcquire();
		const acquire = await acquirePromise;
		if (!acquire || disposed) return;
		for (const getSource of batch) acquire(getSource());
	};

	return {
		enqueue: (key: string, getSource: () => string) => {
			if (disposed) return;
			pending.set(key, getSource);
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void fire();
			}, ATA_DEBOUNCE_MS);
		},
		dispose: () => {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = null;
			pending.clear();
		},
	};
}
