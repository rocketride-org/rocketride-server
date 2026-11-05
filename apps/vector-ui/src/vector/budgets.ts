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
// VECTOR - BUDGETS (one place for every number the console paces itself by)
// =============================================================================

/** The directory keeps loading pages in the background up to this many documents. */
export const DIRECTORY_AUTO_ROWS = 5_000;

/** "Load more" past the cap raises it by this many. */
export const DIRECTORY_LOAD_MORE = 5_000;

/** A quick `stats` refresh at most this often while the console is visible. */
export const QUICK_STATS_INTERVAL_MS = 15_000;

/** Chunks listed per page (the node's `chunks_page` caps it). */
export const CHUNKS_PAGE = 100;

/** The multi-remove dialog lists at most this many paths. */
export const MULTI_REMOVE_LIST_MAX = 20;

/** Pages of the trash listing Empty trash reads before it confirms (100,000 documents at the default page of 500). */
export const EMPTY_TRASH_MAX_PAGES = 200;

/** Files per drop, bytes per file and per drop, enforced before sending (the parser also refuses a file over 50 MB). */
export const UPLOAD_MAX_FILES = 20;
export const UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const UPLOAD_MAX_DROP_BYTES = 200 * 1024 * 1024;

/** Chat: one question at a time, at most this long, waited for this long. */
export const CHAT_QUESTION_MAX_CHARS = 4_000;
export const CHAT_TIMEOUT_MS = 120_000;
