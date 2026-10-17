// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Bookkeeping for a cache that overlapping reloads rebuild while event
 * handlers keep writing to it (the sidebar's parsed `.pipe` files, issue
 * #2466).
 *
 * A reload builds its own map and installs it in one assignment, so a handler
 * deciding meanwhile sees the previous cache whole, not one being refilled.
 * That swap would drop the writes handlers made during the reload (a file
 * deleted during the reload would come back, a changed one would keep its old
 * parse), so every write is applied to the current map and recorded for the
 * reload in progress to re-apply after its swap. Of two overlapping reloads
 * only the newer installs its map; the older is told it was superseded and
 * can wait for the newer one to finish, so a queue that runs the initial
 * reload first never continues against a cache no reload has installed.
 *
 * Kept free of `vscode` so it can be asserted directly (see
 * reloadingCache.test.ts), the way connection-generation.ts is.
 */
export class ReloadingCache<T> {
	private map = new Map<string, T>();
	/** Sequence number of the newest reload begun. */
	private seq = 0;
	/** The newest reload in flight: its number and the writes made since it began. */
	private pending?: { seq: number; writes: Map<string, T | null> };
	/** Resolved when the reload in flight finishes, installed or not. */
	private waiters: Array<() => void> = [];

	/** The installed map. Read only; writes go through {@link write}. */
	get entries(): ReadonlyMap<string, T> {
		return this.map;
	}

	/**
	 * A handler's write: applied to the current map now, and recorded for the
	 * reload in progress, if any, to re-apply after its swap. `null` deletes.
	 *
	 * @param key - The cache key (a file path).
	 * @param value - The new value, or null to delete.
	 */
	write(key: string, value: T | null): void {
		if (value === null) this.map.delete(key);
		else this.map.set(key, value);
		this.pending?.writes.set(key, value);
	}

	/**
	 * Starts a reload and returns its sequence number. A reload begun later
	 * supersedes this one: it sees everything this one sees, and more.
	 *
	 * @returns The number to hand back to {@link finishReload}.
	 */
	beginReload(): number {
		const seq = ++this.seq;
		this.pending = { seq, writes: new Map() };
		return seq;
	}

	/**
	 * Finishes reload `seq`. Its map is installed, with the writes recorded
	 * since it began re-applied on top, only when it is the reload in flight:
	 * an older reload was superseded (the newer one saw everything it saw),
	 * an unknown or already finished one changes nothing. Pass `undefined`
	 * when the reload failed: nothing is installed, and when it was the
	 * newest, waiters are released so they go on with the current map rather
	 * than wait forever.
	 *
	 * The installed map is `parsed` itself, kept by reference and mutated by
	 * the replay, not a copy: a caller must not reuse it.
	 *
	 * @param seq - The number {@link beginReload} returned.
	 * @param parsed - The map the reload built, or undefined when it failed.
	 * @returns Whether the map was installed.
	 */
	finishReload(seq: number, parsed: Map<string, T> | undefined): boolean {
		if (this.pending?.seq !== seq) return false;
		const { writes } = this.pending;
		this.pending = undefined;
		if (parsed !== undefined) {
			for (const [key, value] of writes) {
				if (value === null) parsed.delete(key);
				else parsed.set(key, value);
			}
			this.map = parsed;
		}
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve();
		return parsed !== undefined;
	}

	/**
	 * Resolves once no reload is in flight: at once when none is, else when
	 * the newest one finishes, installed or failed. A superseded reload awaits
	 * this before returning, so whatever waits on it (the created-file queue)
	 * continues against the newer reload's map, not against the one the
	 * superseded reload never installed.
	 *
	 * @returns A promise that settles when the reload in flight has finished.
	 */
	settled(): Promise<void> {
		if (this.pending === undefined) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}
}

/**
 * Whether a path has a whole `node_modules` segment. `findFiles` excludes
 * `**\/node_modules/**`; the file watcher does not, so an event under an
 * installed package must be ignored before anything is written or cached. A
 * segment test, not a substring one: `node_modules_old/` is a user's folder.
 * Both separators are split on, so the same test holds for a Windows
 * `fsPath` and for a POSIX one.
 *
 * @param fsPath - The file's path as the watcher reports it.
 * @returns True when one of the path's segments is exactly `node_modules`.
 */
export function isUnderNodeModules(fsPath: string): boolean {
	return fsPath.split(/[\\/]/).includes('node_modules');
}
