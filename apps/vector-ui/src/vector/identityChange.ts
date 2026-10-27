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
// VECTOR - A CHANGE OF IDENTITY: close what belonged to the previous one (pure)
// =============================================================================
//
// Every connection, with its tokens, probe and sessions, belongs to ONE
// identity: this user, in this organization, with this development team. On a
// change (an account update that picks another team) or a sign-out, the shared
// endpoint store forgets all of it. The open documents and the per-connection
// caches are the app's own, though: a console keeps its directory, chunks,
// uploads and chat on screen, and the map its sample and camera.
//
// So on every change of the identity fingerprint the app closes every
// connection-scoped document (consoles and document tabs) and clears every
// per-connection cache: each cache registers its `clear` with the app's
// registry (adapters/explorer.ts `connectionCaches`), so a cache another part
// of the app adds is cleared without this module knowing it. The Connections
// landing stays; when something was closed it is focused (or opened).
// =============================================================================

/** The part of the app's Documents instance this needs. */
export interface IConnectionDocs {
	/** The current state: every open editor and the document it shows. */
	getState(): { editors: Record<string, { documentUri: string }> };
	/** Close one editor (a static document is disposed with its last editor). */
	closeEditor(editorId: string): void;
	/** Focus the document's tab, or open it in the active group. */
	openStaticDocument(uri: string, label: string): void;
}

/** A set of named per-connection caches, cleared together. */
export interface ICacheRegistry {
	/**
	 * Register a cache's clear function under a name (registering the same name again replaces it), and, for a cache
	 * kept per connection, how to forget one connection.
	 *
	 * @returns The unregister function.
	 */
	register(name: string, clear: () => void, forget?: (connectionKey: string) => void): () => void;
	/** Clear every registered cache; one that throws does not stop the others. Returns the names cleared. */
	clearAll(): string[];
	/**
	 * Forget one connection in every cache that keeps it apart (a dev-tool frame's reset: the realm may run other
	 * mounts). A cache that can only clear everything is left alone. Returns the names that forgot it.
	 */
	forgetKey(connectionKey: string): string[];
	/** The registered names, in registration order. */
	names(): string[];
}

/**
 * Create a cache registry.
 *
 * @returns An empty registry.
 */
export function createCacheRegistry(): ICacheRegistry {
	const caches = new Map<string, () => void>();
	const forgets = new Map<string, (connectionKey: string) => void>();
	return {
		register(name: string, clear: () => void, forget?: (connectionKey: string) => void): () => void {
			caches.set(name, clear);
			if (forget) forgets.set(name, forget);
			else forgets.delete(name);
			return () => {
				if (caches.get(name) !== clear) return;
				caches.delete(name);
				forgets.delete(name);
			};
		},
		forgetKey(connectionKey: string): string[] {
			const forgot: string[] = [];
			for (const [name, forget] of [...forgets]) {
				try {
					forget(connectionKey);
					forgot.push(name);
				} catch {
					// A cache that cannot forget must not keep the others.
				}
			}
			return forgot;
		},
		clearAll(): string[] {
			const cleared: string[] = [];
			for (const [name, clear] of [...caches]) {
				try {
					clear();
					cleared.push(name);
				} catch {
					// A cache that cannot clear itself must not keep the others alive.
				}
			}
			return cleared;
		},
		names: () => [...caches.keys()],
	};
}

/**
 * The editors that show a connection's document (a console or a document tab), never the landing.
 *
 * @param editors - The open editors by id.
 * @param keyOf - The app's "endpoint key of a URI" rule (null for the landing).
 * @returns Their ids, in the order given.
 */
export function connectionEditorIds(editors: Record<string, { documentUri: string }>, keyOf: (uri: string) => string | null): string[] {
	return Object.entries(editors)
		.filter(([, editor]) => keyOf(editor.documentUri) !== null)
		.map(([id]) => id);
}

/**
 * Forget everything that belonged to the previous identity: clear every
 * per-connection cache and close every connection-scoped document. When
 * something was closed, the landing is focused, or opened if it was closed.
 *
 * @param docs - The app's Documents instance, or null before it exists.
 * @param caches - The per-connection caches.
 * @param keyOf - The app's "endpoint key of a URI" rule.
 * @param landing - The landing document's URI and label.
 * @returns How many documents were closed, and which caches were cleared.
 */
export function forgetConnections(docs: IConnectionDocs | null, caches: Pick<ICacheRegistry, 'clearAll'>, keyOf: (uri: string) => string | null, landing: { uri: string; label: string }): { closed: number; cleared: string[] } {
	const cleared = caches.clearAll();
	if (docs === null) return { closed: 0, cleared };
	const ids = connectionEditorIds(docs.getState().editors, keyOf);
	for (const id of ids) docs.closeEditor(id);
	if (ids.length > 0) docs.openStaticDocument(landing.uri, landing.label);
	return { closed: ids.length, cleared };
}
