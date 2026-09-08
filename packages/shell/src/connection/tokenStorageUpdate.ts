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
// TOKEN STORAGE UPDATE — cross-tab token change classification
// =============================================================================
//
// The ConnectionManager listens for `storage` events on the token key so a
// sign-in or sign-out in another tab propagates to this one. Removals are
// handled inline (always a sign-out); this module decides whether a token
// WRITE from another tab warrants reloading this tab into the new session.
// =============================================================================

/** The observable facts about a token write from another tab. */
export interface TokenStorageUpdate {
	/** The token value this tab last saw for the key (null = none stored). */
	oldValue: string | null;
	/** The token value the other tab just wrote (null = removal). */
	newValue: string | null;
	/** The token backing this tab's live session, when authenticated. */
	currentUserToken?: string;
	/** True when this tab currently holds an authenticated account. */
	hasAccountInfo: boolean;
}

/**
 * Decide whether a cross-tab token write should reload this tab.
 *
 * A replacement token that differs from this tab's live session means the
 * user re-authenticated elsewhere — reload to adopt it. A first-time token
 * write only matters when this tab is anonymous (it can now sign in);
 * an already-authenticated tab keeps its session.
 *
 * @param update - The storage-event facts (old/new value + session state).
 * @returns True when this tab should reload into the new session.
 */
export function shouldReloadForTokenStorageUpdate(update: TokenStorageUpdate): boolean {
	const { oldValue, newValue, currentUserToken, hasAccountInfo } = update;

	// Removals are a sign-out, handled by the caller — never a reload here.
	if (newValue === null) return false;

	// Token replaced: reload only if it differs from this tab's live session.
	if (oldValue !== null) {
		return currentUserToken !== newValue;
	}

	// Token appeared for the first time: reload only an anonymous tab.
	return !hasAccountInfo;
}
