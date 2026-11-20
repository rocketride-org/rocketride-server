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
// STAGING STORE — persists staged layers per (user, host app)
// =============================================================================

/**
 * Durable home of a StagedFileSystem's layers in the user's file store:
 *
 *   .staging/<appId>/manifest.json   - the small authoritative index
 *   .staging/<appId>/blobs/<sha256>  - content-addressed, immutable blobs
 *
 * Invariant: THE MANIFEST NEVER REFERENCES A MISSING BLOB. Adding is
 * blob-first (blobs written, then the manifest); removing is manifest-first
 * (the manifest stops referencing, then blobs are deleted). A crash in
 * either window can only produce orphan blobs — harmless dead bytes that
 * gc() removes, authoritatively on every load().
 *
 * References are DERIVED by scanning the manifest; nothing stores refcounts
 * (one content-addressed blob can back any number of entries). Manifest
 * writes run through a serialized chain (same discipline as the agent
 * sessions catalog) so concurrent tabs cannot interleave rewrites.
 *
 * Scope is per (user, host app): the user's own store tree already isolates
 * users; the appId segment isolates hosting apps (pending state is a
 * property of (user, app), not of the files).
 */

import { getClient } from 'shell';
import type { RocketRideClient } from 'shell';
import { sha256Hex } from './hash';
import type { IStagingStore, Layer, LayerEntry } from './stagedFileSystem';

// =============================================================================
// CONSTANTS + MANIFEST SHAPE
// =============================================================================

/** Root directory of all staging state in the user's file store. */
export const STAGING_DIR = '.staging';

/** Characters forbidden in an app id used as a path segment (store rules). */
const INVALID_APPID_CHARS = new Set(['/', '\\', '*', '?', '<', '>', '|', '"']);

/** One serialized entry: content rides in blobs, identified by hash. */
interface ManifestEntry {
	kind: 'write' | 'tombstone' | 'mkdir';
	/** Hash of the staged content (write entries only). */
	contentHash?: string;
	/** Hash of the captured before-content (null = path did not exist). */
	baseHash?: string | null;
	/** Tombstone of a DIRECTORY (no content capture; anchors on existence). */
	dir?: boolean;
	stamp: number;
}

/** One serialized layer. */
interface ManifestLayer {
	id: string;
	label: string;
	sessionId?: string;
	committed?: boolean;
	entries: Record<string, ManifestEntry>;
}

/** The manifest file envelope. */
interface ManifestFile {
	version: 1;
	layers: ManifestLayer[];
}

// =============================================================================
// STAGING STORE
// =============================================================================

export class StagingStore implements IStagingStore {
	/** The host app id — the staging namespace segment. */
	private readonly appId: string;
	/**
	 * Optional scope segment below the app id ('' = none): staged state is a
	 * property of (user, host app, workspace scope), so a workspace rooted
	 * in a team tree keeps its layers apart from the user tree's (and from
	 * other teams'). '' preserves the pre-scope layout.
	 */
	private readonly scopeKey: string;
	/** Serialized writer chain for manifest rewrites (one per store). */
	private chain: Promise<void> = Promise.resolve();
	/** Blob hashes known to exist on the server (skip rewrites). */
	private readonly knownBlobs = new Set<string>();

	/**
	 * Builds the store for one hosting app.
	 *
	 * @param appId - The host app id (e.g. 'rocketride.pipeBuilder').
	 * @param scopeKey - Optional workspace-scope namespace segment
	 *                   (e.g. 'team-<id>'; '' = the user tree's own staging).
	 */
	constructor(appId: string, scopeKey = '') {
		// step: enforce store id rules locally so the refusal is explicit
		if (!appId || appId.startsWith('@') || appId.startsWith('=') || appId.includes('..')
			|| [...appId].some((ch) => INVALID_APPID_CHARS.has(ch) || ch.charCodeAt(0) < 0x20)) {
			throw new Error(`Invalid staging app id: '${appId}'`);
		}
		// step: same rules for the scope segment — it rides the same path
		if (scopeKey && (scopeKey.startsWith('@') || scopeKey.startsWith('=') || scopeKey.includes('..')
			|| [...scopeKey].some((ch) => INVALID_APPID_CHARS.has(ch) || ch.charCodeAt(0) < 0x20))) {
			throw new Error(`Invalid staging scope key: '${scopeKey}'`);
		}
		this.appId = appId;
		this.scopeKey = scopeKey;
	}

	// ── Paths ────────────────────────────────────────────────────────────

	/** The app's staging root (scope-namespaced when a scope key is set). */
	private root(): string {
		return this.scopeKey ? `${STAGING_DIR}/${this.appId}/${this.scopeKey}` : `${STAGING_DIR}/${this.appId}`;
	}

	/** The manifest path. */
	private manifestPath(): string {
		return `${this.root()}/manifest.json`;
	}

	/** One blob's path. */
	private blobPath(hash: string): string {
		return `${this.root()}/blobs/${hash}`;
	}

	/** The connected client, or a loud failure (wiring bug, not a state). */
	private client(): RocketRideClient {
		const client = getClient();
		if (!client) throw new Error('No connected client — workspace staging needs the shell connection.');
		return client;
	}

	// ── IStagingStore ────────────────────────────────────────────────────

	/**
	 * Restores the persisted layers. Missing manifest = nothing staged.
	 * Runs the authoritative orphan sweep afterwards (the GC backstop).
	 *
	 * @returns The layers, or null when nothing is staged.
	 */
	async load(): Promise<Layer[] | null> {
		const client = this.client();
		let manifest: ManifestFile;
		try {
			manifest = await client.fsReadJson<ManifestFile>(this.manifestPath());
		} catch {
			return null;
		}
		if (!Array.isArray(manifest?.layers) || manifest.layers.length === 0) return null;

		// step: collect every referenced blob hash, then bulk-read them
		const hashes = new Set<string>();
		for (const layer of manifest.layers) {
			for (const entry of Object.values(layer.entries)) {
				if (entry.contentHash) hashes.add(entry.contentHash);
				if (entry.baseHash) hashes.add(entry.baseHash);
			}
		}
		const order = [...hashes];
		const contents = new Map<string, string>();
		const decoder = new TextDecoder();
		for (let i = 0; i < order.length; i += 128) {
			const batch = order.slice(i, i + 128);
			const results = await client.fsReadMany(batch.map((h) => this.blobPath(h)));
			for (let j = 0; j < results.length; j++) {
				const r = results[j];
				if (r.ok && r.data) {
					contents.set(batch[j], decoder.decode(r.data));
					this.knownBlobs.add(batch[j]);
				}
			}
		}

		// step: rebuild in-memory layers; a missing blob voids its entry
		// (the invariant says this cannot happen short of manual tampering)
		const layers: Layer[] = [];
		for (const ml of manifest.layers) {
			const entries = new Map<string, LayerEntry>();
			for (const [path, e] of Object.entries(ml.entries)) {
				if (e.kind === 'mkdir') {
					entries.set(path, { kind: 'mkdir', stamp: e.stamp });
					continue;
				}
				const before = e.baseHash ? (contents.get(e.baseHash) ?? null) : null;
				if (e.kind === 'write') {
					const content = e.contentHash ? contents.get(e.contentHash) : undefined;
					if (content === undefined) continue;
					entries.set(path, { kind: 'write', content, before, baseHash: e.baseHash ?? null, stamp: e.stamp });
				} else {
					entries.set(path, { kind: 'tombstone', before, baseHash: e.baseHash ?? null, dir: e.dir, stamp: e.stamp });
				}
			}
			layers.push({ id: ml.id, label: ml.label, sessionId: ml.sessionId, committed: ml.committed, entries });
		}

		// step: authoritative orphan sweep — the GC backstop on every boot
		await this.gc().catch(() => { /* orphans are harmless */ });
		return layers;
	}

	/**
	 * Persists the full layer set: blobs first, manifest last (the add-side
	 * of the invariant). Serialized so concurrent saves never interleave.
	 *
	 * @param layers - The complete current layers.
	 */
	persist(layers: readonly Layer[]): Promise<void> {
		// step: snapshot now; the chained write uses the frozen copy
		const snapshot = layers.map((l) => ({
			id: l.id,
			label: l.label,
			sessionId: l.sessionId,
			committed: l.committed,
			entries: new Map(l.entries),
		}));
		// step: the caller gets THIS write's real outcome, but the stored tail
		// is settle-recovered — one failed persist must not dam every later
		// persist/sweep/gc for the rest of the page session
		const run = this.chain.then(() => this.persistSnapshot(snapshot));
		this.chain = run.catch(() => undefined);
		return run;
	}

	/** The chained body of persist(). */
	private async persistSnapshot(layers: Layer[]): Promise<void> {
		const client = this.client();

		// step: write every missing blob (content + before), hashing as we go
		const manifestLayers: ManifestLayer[] = [];
		for (const layer of layers) {
			const entries: Record<string, ManifestEntry> = {};
			for (const [path, entry] of layer.entries) {
				if (entry.kind === 'mkdir') {
					entries[path] = { kind: 'mkdir', stamp: entry.stamp };
					continue;
				}
				let contentHash: string | undefined;
				if (entry.kind === 'write') {
					contentHash = await sha256Hex(entry.content);
					await this.ensureBlob(client, contentHash, entry.content);
				}
				if (entry.baseHash && entry.before !== null) {
					await this.ensureBlob(client, entry.baseHash, entry.before);
				}
				entries[path] = { kind: entry.kind, contentHash, baseHash: entry.baseHash, dir: entry.kind === 'tombstone' ? entry.dir : undefined, stamp: entry.stamp };
			}
			manifestLayers.push({ id: layer.id, label: layer.label, sessionId: layer.sessionId, committed: layer.committed, entries });
		}

		// step: manifest last — the atomic point; a crash before this line
		// leaves only orphan blobs
		await client.fsWriteJson(this.manifestPath(), { version: 1, layers: manifestLayers } satisfies ManifestFile);
	}

	/** Writes a blob unless this session already knows it exists. */
	private async ensureBlob(client: RocketRideClient, hash: string, content: string): Promise<void> {
		if (this.knownBlobs.has(hash)) return;
		await client.fsWriteString(this.blobPath(hash), content);
		this.knownBlobs.add(hash);
	}

	/**
	 * Deletes this store's staging state — nothing staged remains. Deletes
	 * the manifest (references) FIRST, then the blobs. Deliberately NOT a
	 * recursive delete of root(): scope-namespaced stores nest under the
	 * app's staging directory (.staging/<appId>/team-<id>/...), so the
	 * user-scope store's root CONTAINS them — sweeping it whole would
	 * destroy other scopes' pending state.
	 */
	async sweep(): Promise<void> {
		// step: same settle-recovered tail as persist()
		const run = this.chain.then(async () => {
			const client = this.client();
			try {
				await client.fsDelete(this.manifestPath());
			} catch {
				/* already gone */
			}
			try {
				await client.fsRmdir(`${this.root()}/blobs`, true);
			} catch {
				/* already gone */
			}
			this.knownBlobs.clear();
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	/**
	 * Removes blobs the manifest no longer references (remove-side of the
	 * invariant: the manifest was rewritten first). Best-effort per blob —
	 * failures leave orphans for the next load()'s authoritative pass.
	 */
	async gc(): Promise<void> {
		// step: through the serialized chain — an unserialized GC can read the
		// OLD manifest while a persist is mid-flight, see its fresh blob as
		// unreferenced, and delete it right before the new manifest lands
		const run = this.chain.then(() => this.gcNow());
		this.chain = run.catch(() => undefined);
		return run;
	}

	/** The chained GC body — never runs concurrently with persist/sweep. */
	private async gcNow(): Promise<void> {
		const client = this.client();

		// step: derive the referenced set from the manifest — never stored
		const referenced = new Set<string>();
		try {
			const manifest = await client.fsReadJson<ManifestFile>(this.manifestPath());
			for (const layer of manifest?.layers ?? []) {
				for (const entry of Object.values(layer.entries)) {
					if (entry.contentHash) referenced.add(entry.contentHash);
					if (entry.baseHash) referenced.add(entry.baseHash);
				}
			}
		} catch (err) {
			// step: only a PROVEN-absent manifest means every blob is an
			// orphan; a transient read failure must not empty the referenced
			// set and delete blobs the manifest still names (load() would
			// then drop those staged writes)
			const absent = err instanceof Error && /file not found/i.test(err.message);
			if (!absent) return;
		}

		// step: list blobs and delete the unreferenced remainder
		let names: string[] = [];
		try {
			const { entries } = await client.fsListDir(`${this.root()}/blobs`);
			names = entries.filter((e) => e.type === 'file').map((e) => e.name);
		} catch {
			return;
		}
		for (const name of names) {
			if (referenced.has(name)) continue;
			try {
				await client.fsDelete(this.blobPath(name));
				this.knownBlobs.delete(name);
			} catch {
				/* orphan survives until the next pass */
			}
		}
	}
}
