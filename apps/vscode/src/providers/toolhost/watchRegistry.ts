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
// is minted by the page's WorkspaceFs client as `fs-<page>-<seq>`, so every
// key says which page boot it belongs to.
//
// resetForPageBoot() runs on the page's view:ready and drops every page's
// watchers EXCEPT the newest page's. It must spare the newest page because
// React runs child effects first: a tool's watch can reach the host BEFORE
// the page's view:ready, and a blind reset there dropped the live page's own
// watcher (the MY APPS list then never refreshed after New App). When the
// new page has not watched yet, the newest is still the previous page; its
// watchers survive that boot and retire on the next one.
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

	/**
	 * Starts (or replaces) one subscription.
	 *
	 * @param sub - The watch key (`fs-<page>-<seq>`).
	 * @param start - Creates the subscription's disposables.
	 */
	public add(sub: string, start: () => IDisposable[]): void {
		const page = pageOf(sub);
		if (this.isNewPage(page)) {
			this.newestPage = page;
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

	/** Page boot (view:ready): stops every subscription except the newest page's. */
	public resetForPageBoot(): void {
		for (const sub of [...this.watchers.keys()]) {
			if (pageOf(sub) !== this.newestPage) this.remove(sub);
		}
	}

	/** Stops every subscription (provider teardown). */
	public dispose(): void {
		for (const sub of [...this.watchers.keys()]) this.remove(sub);
		this.newestPage = undefined;
	}

	/** The live subscription keys, oldest first. */
	public keys(): string[] {
		return [...this.watchers.keys()];
	}

	/**
	 * Whether no live subscription belongs to `page` yet.
	 *
	 * @param page - A page from {@link pageOf}.
	 * @returns True for a page not seen among the live subscriptions.
	 */
	private isNewPage(page: string): boolean {
		for (const sub of this.watchers.keys()) {
			if (pageOf(sub) === page) return false;
		}
		return true;
	}
}
