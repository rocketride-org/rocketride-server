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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLHOST — watch subscription registry (vscode-free, unit-tested)
// =============================================================================
//
// Holds the live watch subscriptions for one webview. Each subscription key
// is minted by the page's WorkspaceFs client as `fs-<page>-<seq>`
// (packages/shell/src/ops/workspaceFsClient.ts), so every key says which page
// boot it belongs to. pageOf() splits on the LAST '-', so the page part's
// random suffix must stay dash-free.
//
// resetForPageBoot() runs on the page's view:ready and drops every page's
// watchers EXCEPT the newest page's. It must spare the newest page because
// React runs child effects first: a tool's watch can reach the host BEFORE
// the page's view:ready, and a blind reset there dropped the live page's own
// watcher (the MY APPS list then never refreshed after New App). When
// view:ready comes first, the newest is still the previous page, so the
// reset leaves a boot pending: the new page's first watch then retires every
// older page's watchers at once.
//
// Invariant: one webview page watches through this registry (the sidebar).
// The host.fs.* handlers sit on the root bus, which every attached realm can
// reach; a second realm watching here would be retired by the sidebar's
// view:ready. Give such a realm its own registry.
// =============================================================================

/** Anything that can be stopped (vscode.Disposable has this shape). */
export interface IDisposable {
	dispose(): void;
}

/**
 * The page part of a watch key: `fs-<page>-<seq>` gives `fs-<page>`. A key
 * without a sequence suffix is its own page.
 *
 * @param sub - The watch key.
 * @returns The page the key belongs to.
 */
export function pageOf(sub: string): string {
	const cut = sub.lastIndexOf('-');
	if (cut <= 0) return sub;
	return sub.slice(0, cut);
}

/** The live watch subscriptions of one webview, grouped by page boot. */
export class WatchRegistry {
	/** Disposables per subscription key. */
	private watchers = new Map<string, IDisposable[]>();

	/** The most recently first-seen page: the live one. */
	private newestPage: string | undefined;

	/** Every page ever seen, so a page whose watchers were all removed and
	 *  that watches again is not mistaken for a new page boot. Bounded by one
	 *  short entry per page boot for the extension's lifetime; it can't be
	 *  pruned, because a dead page's late watch must still read as old. */
	private seenPages = new Set<string>();

	/** view:ready arrived before the new page's first watch: that watch
	 *  retires every older page's watchers. */
	private bootPending = false;

	/** The newest page at the last view:ready (detects whether a new page
	 *  watched in between). */
	private newestAtLastBoot: string | undefined;

	/**
	 * Starts (or replaces) one subscription.
	 *
	 * @param sub - The watch key (`fs-<page>-<seq>`).
	 * @param start - Creates the subscription's disposables.
	 */
	public add(sub: string, start: () => IDisposable[]): void {
		const page = pageOf(sub);
		if (this.isNewPage(page)) {
			this.seenPages.add(page);
			this.newestPage = page;
			if (this.bootPending) {
				// This page completes the pending boot: it is now the booted page.
				this.bootPending = false;
				this.newestAtLastBoot = page;
				this.dropOtherPages(page);
			}
		}
		this.remove(sub);
		this.watchers.set(sub, start());
	}

	/**
	 * Stops one subscription (no-op when unknown).
	 *
	 * @param sub - The watch key.
	 */
	public remove(sub: string): void {
		const disposables = this.watchers.get(sub);
		if (!disposables) return;
		this.watchers.delete(sub);
		for (const disposable of disposables) disposable.dispose();
	}

	/**
	 * Page boot (view:ready): stops every subscription except the newest
	 * page's. A boot is left pending only when no new page has watched since
	 * the last view:ready (the new page's watch comes after this one); in the
	 * usual order (watch, then view:ready) the new page is already the newest
	 * and nothing is left to retire.
	 *
	 * Known limit: view:ready carries no page id, so if a page watches and is
	 * then reloaded before its own view:ready, the next page's view:ready can't
	 * tell the two apart, and that page's watchers linger until the next boot
	 * (their events go to a page that ignores them; the live page is never
	 * affected). Sending the page id with view:ready would close it.
	 */
	public resetForPageBoot(): void {
		if (this.newestPage !== undefined) {
			this.dropOtherPages(this.newestPage);
		}
		this.bootPending = this.newestPage === this.newestAtLastBoot;
		this.newestAtLastBoot = this.newestPage;
	}

	/** Stops every subscription (provider teardown). */
	public dispose(): void {
		for (const sub of [...this.watchers.keys()]) this.remove(sub);
		this.newestPage = undefined;
		this.seenPages.clear();
		this.bootPending = false;
		this.newestAtLastBoot = undefined;
	}

	/** The live subscription keys, oldest first (used by the tests). */
	public keys(): string[] {
		return [...this.watchers.keys()];
	}

	/**
	 * Whether `page` has never been seen (a new page boot), regardless of
	 * which of its watchers happen to be live.
	 *
	 * @param page - A page from {@link pageOf}.
	 * @returns True the first time a page appears.
	 */
	private isNewPage(page: string): boolean {
		return !this.seenPages.has(page);
	}

	/**
	 * Stops every subscription that does not belong to `page`.
	 *
	 * @param page - The page to keep.
	 */
	private dropOtherPages(page: string): void {
		for (const sub of [...this.watchers.keys()]) {
			if (pageOf(sub) !== page) this.remove(sub);
		}
	}
}
