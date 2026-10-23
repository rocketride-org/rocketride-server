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
// A11Y — ANNOUNCE (the app's polite live-region channel)
// =============================================================================
//
// SQL Explorer's own announcer, made by the shared factory
// (shared/explorer/a11y). The shell has no live-region utility, so outcomes
// that are visible but not focused — a run finishing, an entry pinned, a join
// path found — would reach a screen-reader user only if they happened to be
// reading the right part of the page. `announce` is the write end; the read
// end is the single LiveRegion the app mounts once.
// =============================================================================

import { createAnnouncer } from 'shared/explorer/a11y/announce';

export type { IAnnouncement as Announcement } from 'shared/explorer/a11y/announce';

/** SQL Explorer's announcement channel. */
export const sqlAnnouncer = createAnnouncer();

/**
 * Announce one short outcome to assistive technology.
 *
 * Politely: the live region never interrupts. Errors are already announced
 * assertively by `Banner`, so they do not belong here.
 *
 * @param text - The sentence to announce.
 */
export const announce = sqlAnnouncer.announce;

/**
 * Subscribe to announcements.
 *
 * @param callback - Called after every announcement.
 * @returns The unsubscribe function.
 */
export const subscribeAnnouncements = sqlAnnouncer.subscribe;

/**
 * The current announcement. Safe as a `useSyncExternalStore` snapshot: the
 * same object is returned until the next {@link announce}.
 */
export const getAnnouncement = sqlAnnouncer.get;
