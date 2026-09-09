/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * IIFE entry point — the file served as `rocketride-chat.js`.
 *
 * One classic `<script>` tag gives host pages both consumption modes:
 *
 * 1. Web component (always): registers the `<rocketride-chat>` custom
 *    element so the page can place it inline anywhere:
 *    ```html
 *    <script src=".../rocketride-chat.js" defer></script>
 *    <rocketride-chat engine-url="http://localhost:5565" auth="YOUR-PUBLIC-AUTH-KEY"></rocketride-chat>
 *    ```
 *
 * 2. Launcher bubble (opt-in): when the script tag itself carries
 *    `data-engine-url`, the loader auto-mounts a floating launcher bubble
 *    configured from the tag's `data-*` attributes (see `loader.ts`).
 *
 * `document.currentScript` is read here, during the synchronous top-level
 * evaluation of the bundle — it is available for classic scripts including
 * `defer`red ones (but would be `null` in a `type="module"` script, which is
 * why the bubble mode requires the IIFE bundle).
 *
 * SECURITY: `auth` / `data-auth` must always be the pipeline's PUBLIC
 * authorization key (the `{public_auth}` from the chat node's
 * `{host}/chat?auth={public_auth}` link) — never the engine API key.
 *
 * @module entry-iife
 */

import { register } from './index';
import { initFromScript } from './loader';

// Register <rocketride-chat> (no-op if the element is already defined, e.g.
// when the bundle is accidentally included twice).
register();

// Auto-mount the launcher bubble when this script tag is configured for it.
initFromScript();
