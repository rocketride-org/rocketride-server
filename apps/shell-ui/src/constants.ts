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
// CONSTANTS — centralized magic strings and configuration values
// =============================================================================

// =============================================================================
// STORAGE KEYS
// =============================================================================

/** sessionStorage: auth token — survives refresh, cleared on tab close. */
export const LS_TOKEN = 'rr:user_token';

/**
 * sessionStorage: app locked for this browser session.
 * Written when `?appId=` is found in the URL; survives the OAuth redirect
 * round-trip (same tab) but cleared when the tab is closed.
 */
export const SS_APP_ID = 'rr:session_app_id';

/** sessionStorage: current auth phase. */
export const SS_PHASE = 'rr:auth_phase';

/** sessionStorage: app to activate after OAuth callback. */
export const SS_PENDING_APP_ID = 'rr:appId';

// =============================================================================
// DEFAULTS
// =============================================================================

/** Default client name sent to the server during handshake. */
export const DEFAULT_CLIENT_NAME = 'shell-ui';

/** Maximum entries in the debug log circular buffer. */
export const DEBUG_LOG_MAX = 500;

/** Timeout (ms) for connect attempts before giving up. */
export const CONNECT_TIMEOUT_MS = 8000;

/** Maximum retry attempts for connection (0 = unlimited with SDK persist). */
export const MAX_RETRY_ATTEMPTS = 120;

/** Default workspace directory for file persistence. */
export const DEFAULT_WORKSPACE_DIR = '.workspace';

// =============================================================================
// APP IDS
// =============================================================================

/** The home app shown to unauthenticated users (SaaS). */
export const HOME_APP_ID = 'rocketride.home';

/** The hello app shown to unauthenticated users (OSS). */
export const HELLO_APP_ID = 'rocketride.hello';
