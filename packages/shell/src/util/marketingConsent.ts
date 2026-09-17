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

// Marketing-consent store — the one switch the ad pixel waits on.
//
// Default DENY: until the visitor explicitly allows marketing measurement,
// the state is 'unset' and nothing third-party loads. The decision lives in
// localStorage under the shell's `rr:` namespace so it survives reloads, and
// the 'storage' event carries it to other open tabs. Storage that throws
// (privacy modes, blocked cookies) degrades to an in-memory decision for the
// current page — never an exception.
//
// Framework-free on purpose: bootstrap (pre-React) subscribes to load the
// pixel, and React reads it through useSyncExternalStore.

export type MarketingConsent = 'granted' | 'denied' | 'unset';

export const CONSENT_STORAGE_KEY = 'rr:consent:marketing';

type Listener = () => void;

const listeners = new Set<Listener>();
let current: MarketingConsent | null = null;
let storageHooked = false;

function readStored(): MarketingConsent {
	try {
		const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
		return raw === 'granted' || raw === 'denied' ? raw : 'unset';
	} catch {
		return 'unset';
	}
}

function notify(): void {
	for (const fn of Array.from(listeners)) {
		try {
			fn();
		} catch {
			// A failing subscriber must not starve the others.
		}
	}
}

// Another tab decided: re-read and fan out. Registered lazily so importing
// this module has no side effects (the test suite swaps `window` per case).
function hookStorageEvent(): void {
	if (storageHooked || typeof window === 'undefined') return;
	storageHooked = true;
	try {
		window.addEventListener('storage', (e: StorageEvent | { key: string | null }) => {
			if (e.key !== null && e.key !== CONSENT_STORAGE_KEY) return;
			current = readStored();
			notify();
		});
	} catch {
		// No event support — cross-tab sync is best-effort.
	}
}

/** The current marketing-consent decision ('unset' until the visitor chooses). */
export function getMarketingConsent(): MarketingConsent {
	if (current === null) current = typeof window === 'undefined' ? 'unset' : readStored();
	return current;
}

/** Record the visitor's decision, persist it, and notify subscribers. */
export function setMarketingConsent(value: 'granted' | 'denied'): void {
	current = value;
	try {
		window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
	} catch {
		// Cannot persist — the decision still holds for this page.
	}
	notify();
}

/** Subscribe to decision changes (this tab or another). Returns the unsubscribe. */
export function subscribeMarketingConsent(fn: Listener): () => void {
	hookStorageEvent();
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** Test hook: drop cached state, listeners, and the storage-event registration. */
export function resetMarketingConsentForTests(): void {
	listeners.clear();
	current = null;
	storageHooked = false;
}
